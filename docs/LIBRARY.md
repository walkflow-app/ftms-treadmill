# ftms-treadmill: design

The treadmill control of [Walkflow](https://github.com/walkflow-app/walkflow), as a library of its own with a defined API:
the app only draws, and the control is released, versioned and tested on its own. Short introduction for users:
[README](../README.md); every function with an example: [API.md](API.md). "The app" below means Walkflow, the first user of the library; its side is in Walkflow's
[docs/ARCHITECTURE.md](https://github.com/walkflow-app/walkflow/blob/main/docs/ARCHITECTURE.md).

## Why

- **One place for what moves the belt.** The safety rules were pure and tested (`core/safety`), but the order of the
  steps around them (ask for control, set the start speed, start; stop urgently and again; end the ramp when the treadmill
  refuses a speed) lived in the app's `ui/live/belt.ts`, `live-data.ts`, `speed-controls.ts` and `connection.ts`. Now it is
  behind an API that the UI cannot get around.
- **A stable version to work against.** The app pins a version of the library that was checked on a real treadmill. A UI
  change cannot change how the belt is driven.
- **Usable by others.** An FTMS treadmill control with a speed limit, a ramp and a reliable stop, for any page or Node program.

## What goes in, what stays

| In the library | Stays in the app |
| --- | --- |
| FTMS parsers and commands (`protocol/ftms.ts`) | Texts and languages (`i18n`), units |
| The facade (`device/treadmill.ts`); Bluetooth client, write queue, timeout (`device/ble.ts`) | Storage of limit, step, presets, disclaimer (the storage keys; Walkflow's `src/core/safety/`) |
| Simulator (`device/sim.ts`) | Workouts, routes, the program runner, history, export |
| Speed limit, ramp, governor, standstill (`safety/safety.ts`) | The disclaimer and the confirmation above 6 km/h |
| Incline range and clamping (`safety/incline.ts`) | Banner, buttons, figures, chart (drawn from the library's state); the banner's fading and timings |
| Belt phase (`safety/belt-phase.ts`) and which buttons may be used (`controlAvailability`) | Speed presets (they end in `setSpeed`) |
| Start, stop, pause and their order (`device/belt-commands.ts`) | Experiment console screen |
| Reading what the treadmill reports (`device/reports.ts`; recording stays in the app) | Wake lock, background, desktop shell |
| The check of raw console commands (`checkConsoleCommand`) | |

The library has **no DOM, no storage, no texts and no network** besides Bluetooth. It knows nothing about workouts or routes:
a program drives it through the same API as a button.

## API

The whole API, with an example for each part, is in [API.md](API.md). In short: `createTreadmill(options)` makes one
object that owns everything that drives the belt; `connect(adapter)` gives it a treadmill (Web Bluetooth, the simulator
or an adapter of your own); `start`, `stop`, `pause`, `setSpeed`, `setIncline` drive it; `state` and the events say
what it does. The sections below explain the parts whose reasons are not obvious from the signatures.

The adapter is given to `connect`, not to `createTreadmill`: one Treadmill keeps its limits across connections, to a real
treadmill or the demo.

### Belt phase and controls

The library says **what the belt does**, the app decides **how that looks**. `belt-banner.ts` used to do both: it knew that a
start was sent and the treadmill still counts down, and it also computed how strong the green or red is. The first part is
control (the Start button stays locked during the countdown, so nobody starts twice), the second is design. They are split:
`safety/belt-phase.ts` in the library, `ui/live/belt-banner.ts` in the app.

| `state.belt` | Means |
| --- | --- |
| `unknown` | connected, nothing reported yet |
| `starting` | Start was sent, the belt does not move yet (until it is measured at 0.3 km/h or more, at most `START_MS`) |
| `running` | the belt moves |
| `stopping` | Stop or Pause was sent, or the treadmill reported a stop, and the belt still moves |
| `standing` | the belt stands (below 0.1 km/h) |

`state.controls` is `controlAvailability` of today: Start is locked while the belt may be running, a start is under way or a
program runs; Pause is there while the belt may be running; **Stop is there whenever the treadmill is connected**, and
nothing in the library takes it away. The app's buttons follow `controls` and add nothing of their own.

The banner in the app follows `state.belt` and keeps its own look: the fading green, the red that gets stronger as the belt
slows down, how long it stays after the belt stands, and its texts. A change to the banner is an app change, not a library
release; the API knows no opacity.

`program` in the availability (Start locked while a program runs) is told by the app, which owns programs:
`tm.setProgramActive(active: boolean)`.

### Standstill

The library watches for a belt that stands still while a speed is wanted (only 0 km/h for 8 seconds, e.g. stopped with the
remote or the safety key without a Machine Status). Then it forgets the ramp, so nothing starts the belt again, and sends
`ended` with `standstill`.

The API only says **where a speed came from** (`source`), never whether the standstill is watched: that is the library's
decision and can change without a new API. In 0.x it does what the app does today and watches only speeds with
`source: 'program'`. Watching every speed while the belt should run is planned as a `safety` change of its own after that,
tested on a real treadmill; the app does not have to change for it.

### Notices instead of texts

The library knows no language. What it finds or what goes wrong it sends as a code with its values, and the app turns each
code into text in its languages (Walkflow: `ui/live/treadmill-text.ts`). Switching over `code` lets TypeScript check that
every code has a text; `tests/architecture.test.ts` checks that the library imports nothing outside its own folder.

The codes are in `src/protocol/notice.ts`; each one with its values and an example: [API.md, Notices](API.md#notices).

| Group | Codes |
| --- | --- |
| Connecting | `device`, `device-info`, `not-subscribable`, `features`, `controllable`, `features-unreadable`, `speed-range`, `speed-range-unreadable`, `incline-range`, `incline-range-unreadable`, `heart-rate` |
| Writing | `write-dropped`, `write-failed` (with `no-gatt`, `not-connected`, `write-timeout` or the message of another error) |
| Governor | `no-allowed-speed`, `speed-held-until-moving`, `ramp-aborted` |
| Console (returned by `checkConsoleCommand`) | `console-set-speed-length`, `console-over-limit`, `console-jump`, `console-too-soon`, `console-heart-rate` |
| Start, stop and limits (the facade) | `start-speed-failed`, `speed-refused`, `limit-lowered`, `limit-unconfirmed` (see below) |

The app has four codes of its own in the same style, for the limit it stores and edits (`src/core/safety/limit-settings.ts`:
`limit-not-a-number`, `limit-out-of-range`, `limit-stored-unconfirmed`, `limit-legacy-not-adopted`); the library never sends them.

Control lost and a standstill are not notices: the first is a Machine Status (`machineStatus` event), the second an `ended` reason.

Only `connect` throws, with the adapter's own error (no device chosen, no FTMS). A failed write is a `TreadmillError`
(`no-gatt`, `not-connected`, `write-timeout`), which the library catches itself and reports as `write-failed`. Machine Status and
Control Point answers stay what the protocol says (`MachineEvent`, `ControlPointResponse`); the app describes them in its
language. The `log` event carries protocol lines only (bytes sent, an answer that could not be read).

### Speed limit above 6 km/h

A limit above `LIMIT_CONFIRM_ABOVE` (6 km/h) only counts when a person said yes to it. The app asks (the dialog with the
risk) and stores the yes with the value, as it does today. The library does not ask anybody, but it insists on being told:
`speedLimit` above 6 km/h without `limitConfirmed: true` (in `createTreadmill` or `setLimits`) is not taken. The library
uses 6 km/h instead and sends `{ code: 'limit-unconfirmed', requested, applied }`, so the app can say so.

This is not a lock: whoever uses the library can write `true`. It makes the step explicit, so that it shows in the code and
in a review and cannot happen by mistake (a broken stored value, a typo, a slider out of range). The flag is in the API from
the start because adding it later would break every caller; loosening it later would not.

`limitConfirmed` belongs to the value it was given with: `setLimits({ speedLimit: 8 })` without the flag is again 6 km/h.
Lowering the limit never needs it.

## What the library promises

These are the safety rules of today, written as the library's contract. Each one has a test in the library, and a change to
one of them is a `safety` commit and at least a minor version.

1. Nothing above `speedLimit` (or the device maximum, whichever is lower) is ever sent, also not through `sendRaw`.
   A `speedLimit` above 6 km/h counts only with `limitConfirmed: true`, otherwise it is 6 km/h.
2. The speed changes by at most `maxStep` per command and not more often than every `RAMP_INTERVAL_MS`.
3. Before Start the lowest allowed speed is set, so a treadmill does not run up to the speed it last had. After Start the
   speed asked for last (chosen while standing, or the one before a stop or pause) is ramped up to from there, once the
   belt moves.
4. Stop and Pause go out ahead of everything queued, end a Start that is still being sent, ask for control first if it was
   lost, and are sent up to `STOP_ATTEMPTS` times. If none went through, `state.stopFailed` is true.
5. A refused Stop on a moving belt sets `stopFailed`; a refused speed ends the ramp.
6. A write that gets no answer is given up after `WRITE_TIMEOUT_MS`, so it cannot hold back a Stop.
7. When the treadmill stops by itself (button, safety key) or the belt stands still while a speed is wanted (see
   [Standstill](#standstill)), the ramp is forgotten and `ended` is sent.
8. No method throws during a session (only `connect`); a failed command is `false` plus a notice.

## Packaging

- **Its own repository** ([walkflow-app/ftms-treadmill](https://github.com/walkflow-app/ftms-treadmill)), published to
  npm as `ftms-treadmill`. Until 0.1.1 it lived in Walkflow's repository as the workspace `packages/ftms-treadmill`; that
  history came along. ES modules only, no dependencies; built with `tsc` into `dist/` (`npm run build`). Imports name
  their `.ts` files and the build turns them into `.js`, so the published files run in Node as they are.
- **Entry points:** `ftms-treadmill` (core, pure, runs in Node), `/web-bluetooth` (the browser adapter), `/sim`
  (simulator), `/protocol` (FTMS parsers and commands for anyone who wants only those). Nothing else is exported.
- **Types:** the declarations (`dist/*.d.ts`) come with the package. The Web Bluetooth types (`@types/web-bluetooth`) are
  needed only to build it, and only in `src/device/web-bluetooth.ts`; the published declarations do not use them, so users
  need nothing extra.
- **Rules** (`tests/architecture.test.ts`): the library imports nothing outside `src/` and no package; only its Web
  Bluetooth adapter touches the browser; no import cycles; exactly the four entry points are exported; every test sits next
  to its code.
- **Walkflow** pins an exact version from npm. A change here reaches the app only after a release; to try it in the app
  before that, `npm run build` here and `npm link ../ftms-treadmill` in Walkflow.
- **Releases:** release-please keeps a release pull request (version from the Conventional Commit titles, `CHANGELOG.md`).
  Merging it creates the tag `v<version>` and a draft release. Before publishing the draft, check a version with changes
  to the belt on a real treadmill (Walkflow's [HARDWARE-TESTS.md](https://github.com/walkflow-app/walkflow/blob/main/HARDWARE-TESTS.md)).
  Publishing it starts `.github/workflows/npm-publish.yml`: tests, a check that the tag matches the version, the build,
  `npm publish` with provenance. No token: npm trusts that workflow (Trusted Publishing, set in the package settings on
  npmjs.com: GitHub Actions, `walkflow-app/ftms-treadmill`, `npm-publish.yml`, no environment).
- **Documentation:** the `Treadmill` interface, its options, state and events describe every member in a comment that
  editors show (`tests/docs.test.ts` checks it). [API.md](API.md) covers every export (`tests/docs.test.ts` fails when something new is not in it),
  and every `ts` example in it and in the README compiles against the sources (`npm run check:docs`, in CI).
  `examples/simulator.ts` runs in CI after the build, against the built package.
- **Version 0.x** until the API has been used for a while; then 1.0.
