# ftms-treadmill

Controls a treadmill that speaks **FTMS** (Bluetooth Fitness Machine Service) and keeps the belt safe while doing it: a
speed limit that is never exceeded, speed changes in small steps, and a Stop that always gets through. It has no user
interface, no storage and no texts of its own. You draw the buttons; it drives the belt.

It is the treadmill control of [Walkflow](https://github.com/walkflow-app/walkflow), tested on real treadmills (a sPad 500
so far). Version 0.x: the API may still change in a minor version. Each change is listed in the changelog.
Up to 0.1.1 it lived in Walkflow's repository; since 0.1.2 it has [its own](https://github.com/walkflow-app/ftms-treadmill).

> **Use at your own risk.** A treadmill can hurt people. This library makes mistakes less likely, it does not make them
> impossible. Always keep the treadmill's own stop and safety key within reach. Not affiliated with any treadmill maker.

## Install

```sh
npm install ftms-treadmill
```

ES modules only, no dependencies. Runs in browsers with Web Bluetooth (Chrome, Edge, Electron) and in Node (with the
simulator or an adapter of your own).

## Use

```ts
import { createTreadmill } from 'ftms-treadmill';
import { WebBluetoothAdapter } from 'ftms-treadmill/web-bluetooth';

const tm = createTreadmill({ speedLimit: 6, maxStep: 0.5 });

tm.on('data', d => console.log(d.speed, d.dist, d.incl));   // what the treadmill reports
tm.on('notice', n => console.log(n.code, n));               // codes, not sentences: say them in your language
tm.on('ended', e => console.log('belt ended:', e.reason));  // stopped by the app, on the treadmill or by the safety key

await tm.connect(new WebBluetoothAdapter());  // in a click handler: the browser shows its device picker
await tm.start();                             // asks for control, sets the lowest speed, then Start
tm.setSpeed(3.5);                             // ramps there in steps once the belt moves, never above the limit
await tm.stop();                              // urgent, sent again if it did not go through
```

Read `tm.state` whenever you draw: `state.controls` says which of Start, Pause and Stop may be pressed now (Stop always,
while connected), `state.belt` what the belt is doing (`standing`, `starting`, `running`, `stopping`), `state.target` where
the ramp is going.

### Without a treadmill

```ts
import { SimulatorAdapter } from 'ftms-treadmill/sim';

await tm.connect(new SimulatorAdapter());     // a simulated FTMS treadmill, also in Node
```

## Entry points

| Import | What |
| --- | --- |
| `ftms-treadmill` | `createTreadmill`, the types, the limits and constants. Pure, no browser needed. |
| `ftms-treadmill/web-bluetooth` | `WebBluetoothAdapter`, the only part that touches `navigator.bluetooth`. |
| `ftms-treadmill/sim` | `SimulatorAdapter`, a simulated treadmill for demos and tests. |
| `ftms-treadmill/protocol` | The FTMS parsers and commands on their own, for anyone who handles the bytes themselves. Nothing here keeps a belt safe. |

## What it promises

1. Nothing above the speed limit (or the treadmill's maximum, whichever is lower) is ever sent. A limit above 6 km/h counts
   only with `limitConfirmed: true`.
2. The speed changes by at most `maxStep` per command, at most once every 1.5 s.
3. Before Start the lowest speed is set, so a treadmill does not jump back to the speed it last had.
4. Stop and Pause go out ahead of everything queued, and are sent up to 3 times. If none got through, `state.stopFailed`
   is true and the `stopFailed` event says so.
5. When the treadmill stops by itself (its button, the safety key), the ramp is forgotten and `ended` is sent (once per run of the belt).
6. No method throws during a session (only `connect`); a failed command returns `false` and sends a notice.

## Documentation

- **[API reference](https://github.com/walkflow-app/ftms-treadmill/blob/main/docs/API.md)**: every function, option, event and notice code, each with an example, plus
  recipes (a complete page, a workout, tests without a treadmill, your own Bluetooth adapter).
- **[Design](https://github.com/walkflow-app/ftms-treadmill/blob/main/docs/LIBRARY.md)**: why it works the way it does: belt phases, standstill, the limit above 6 km/h, the
  promises above and how releases are made.
- **[Example in Node](https://github.com/walkflow-app/ftms-treadmill/blob/main/examples/simulator.ts)**: drives the simulator from start to stop (`npm run example`).

## Develop

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npm run check:docs   # every example in the docs compiles
npm run example      # drives the simulator from start to stop
```

Commit titles follow [Conventional Commits](https://www.conventionalcommits.org/) (`safety:`, `feat:`, `fix:`, …); they
make the version and the changelog. Code that decides what is sent to the treadmill (`src/device/treadmill.ts`,
`src/device/belt-commands.ts`, `src/safety/`) changes test first (the CI job `safety-gate` fails a pull request that
changes it without changing a test), and a release with such a change is checked on a real
treadmill before it is published. How releases work: [docs/LIBRARY.md](https://github.com/walkflow-app/ftms-treadmill/blob/main/docs/LIBRARY.md#packaging).
`main` takes changes only through pull requests with CI green. Rules for AI agents are in `CLAUDE.md`, the commands they may
run in `.claude/settings.json`, their skills (release, specs) and reviewers (safety, API) in `.claude/`.

## Agents on GitHub

Every new pull request gets a review by AI agents (`.github/workflows/agent-review.yml`): they check what this repository's
`CLAUDE.md` asks for and post one comment with their verdict. Maintainers can ask for more with `@claude …` in a comment, or hand
over an issue with the label `agent-ready` (`.github/workflows/claude.yml`); agents never take on issues labelled `safety` and
never merge. Pull requests from forks are not reviewed by agents.

## Roadmap

What is being done on the library, what comes next and what may come later: [ROADMAP.md](ROADMAP.md).

## Support

If the library is useful to you, you can support it through [thanks.dev](https://thanks.dev/u/gh/walkflow-app) or
[Ko-fi](https://ko-fi.com/walkflowapp).

## License

MIT
