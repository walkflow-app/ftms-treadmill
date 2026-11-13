# API reference

Everything `ftms-treadmill` exports, with an example for each. Units everywhere: speed in **km/h**, incline in **percent**,
distance in **meters**, time in **milliseconds** (the `time` the treadmill reports is in seconds, as FTMS sends it).

Why the library works the way it does (belt phases, standstill, the limit above 6 km/h, the promises it keeps) is in
[LIBRARY.md](LIBRARY.md). Every example on this page is type-checked in CI (`npm run check:docs`); in the examples, `tm` is a
treadmill made with `createTreadmill()` and connected with `tm.connect(…)`.

- [Entry points](#entry-points)
- [`createTreadmill`](#createtreadmill) and its [options](#treadmilloptions)
- [The treadmill](#the-treadmill): [connecting](#connecting), [the belt](#the-belt), [speed and incline](#speed-and-incline),
  [limits and programs](#limits-and-programs), [raw commands](#raw-commands), [state](#state), [events](#events)
- [Notices](#notices) and [errors](#errors)
- [Adapters](#adapters): [Web Bluetooth](#ftms-treadmillweb-bluetooth), [simulator](#ftms-treadmillsim), [your own](#your-own-adapter)
- [Helpers and constants](#helpers-and-constants)
- [The protocol on its own](#ftms-treadmillprotocol)
- [Recipes](#recipes)

## Entry points

| Import | What | Runs in |
| --- | --- | --- |
| `ftms-treadmill` | `createTreadmill`, the types, the limits and constants | browser and Node |
| `ftms-treadmill/web-bluetooth` | `WebBluetoothAdapter` | browsers with Web Bluetooth (Chrome, Edge, Electron) |
| `ftms-treadmill/sim` | `SimulatorAdapter`, `SimulatedBelt` | browser and Node |
| `ftms-treadmill/protocol` | the FTMS parsers and commands on their own | browser and Node |

Import only from these four; nothing else is part of the API. The core never touches the browser, so a page that only
shows the simulator does not need Web Bluetooth.

## `createTreadmill`

`createTreadmill(options?: TreadmillOptions): Treadmill`

Makes a treadmill object. It is not connected yet; give it an adapter with [`connect`](#tmconnectadapter). One object
keeps its limits across connections, so make it once and connect it as often as you like (to a real treadmill, then to the
simulator, and back).

```ts
import { createTreadmill } from 'ftms-treadmill';

const tm = createTreadmill({ speedLimit: 5, maxStep: 0.3 });
console.log(tm.state.speedLimit, tm.state.maxStep); // 5 0.3
```

### `TreadmillOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `speedLimit` | `DEFAULT_SPEED_LIMIT` (6) | The highest speed ever sent, km/h, `LIMIT_MIN`..`LIMIT_MAX` (1..20). Nonsense (`NaN`) is the default. |
| `limitConfirmed` | `false` | A person agreed to a limit above `LIMIT_CONFIRM_ABOVE` (6 km/h). Without it, such a limit is 6 km/h ([why](LIBRARY.md#speed-limit-above-6-kmh)). |
| `maxStep` | `DEFAULT_MAX_STEP` (0.5) | km/h per speed command while ramping, `MAX_STEP_MIN`..`MAX_STEP_MAX` (0.1..1). |
| `clock` | real time | `{ now(): number; wait(ms): Promise<void> }`, for tests with a fake clock. |

```ts
import { createTreadmill } from 'ftms-treadmill';

// A limit above 6 km/h counts only with the confirmation, which a person gave (ask them in your UI)
const tm = createTreadmill({ speedLimit: 8, limitConfirmed: true });

// Without it, the limit is 6 km/h and a 'limit-unconfirmed' notice says so
const careful = createTreadmill({ speedLimit: 8 });
console.log(careful.state.speedLimit); // 6
```

### `Clock`

The clock the treadmill uses for its timings (ramp interval, start phase, the pause between two attempts to stop). Pass
your own to test code that uses the library without waiting:

```ts
import { createTreadmill, type Clock } from 'ftms-treadmill';

let t = 0;
const clock: Clock = {
  now: () => t,
  wait: async ms => { t += ms; },
};
const tm = createTreadmill({ clock });
```

## The treadmill

`Treadmill` is what `createTreadmill` returns. Every method and field also carries a short description that editors show
on hover. No method throws once connected (only `connect` can); a command that fails
returns `false` or `null` and sends a [notice](#notices).

### Connecting

#### `tm.connect(adapter)`

`connect(adapter: BleAdapter): Promise<ConnectResult>`

Asks the adapter for a device (with Web Bluetooth: the browser's device picker), connects, subscribes to what the treadmill
reports, reads what it can do and asks for control. Calling it again while connected returns the same result.

Throws if there is no device (the person closed the picker) or the device has no FTMS service; the error is the adapter's
own (with Web Bluetooth a `DOMException`, e.g. `NotFoundError` when the picker was closed).

```ts
import { createTreadmill } from 'ftms-treadmill';
import { WebBluetoothAdapter } from 'ftms-treadmill/web-bluetooth';

const tm = createTreadmill();
document.querySelector('#connect')!.addEventListener('click', async () => {
  // Web Bluetooth only opens its picker during a click (a "user gesture")
  try {
    const info = await tm.connect(new WebBluetoothAdapter());
    console.log(info.deviceName, info.speedRange, info.inclRange, info.hasHeartRate);
  } catch (e) {
    console.log('not connected:', e);
  }
});
```

#### `ConnectResult`

| Field | Meaning |
| --- | --- |
| `deviceName` | the name the device advertises, if any |
| `features` | the treadmill's FTMS features ([`Features`](#features)), if readable |
| `speedRange` | the speeds it accepts ([`Range`](#range)), if readable; until then 1–12 km/h is assumed |
| `inclRange` | the inclines it accepts, if readable |
| `hasHeartRate` | it offers the Heart Rate service (heart rate then comes as the `heartRate` event) |

#### `tm.disconnect()`

`disconnect(): void`

Ends the connection. The `disconnected` event follows. **It does not stop the belt**: stop first if it may be running.

```ts
if (tm.state.maybeRunning) await tm.stop();
tm.disconnect();
```

### The belt

#### `tm.start()`

`start(): Promise<boolean>`

Asks for control, sets the treadmill's lowest speed (so it does not jump back to the speed it had last time), sends Start
and then ramps up to the last speed asked for, if any. `true` if both Request Control and Start went through; `false` if one
failed or a Stop or Pause came in while it was on its way (then nothing more of it is sent).

Check `tm.state.controls.start` before offering Start: it is `false` while the belt may still be moving, a start is under
way or a program runs.

```ts
tm.setSpeed(3); // chosen while the belt stands: held, and ramped up to after Start
if (tm.state.controls.start && (await tm.start())) {
  console.log('belt starting, phase:', tm.state.belt); // 'starting', then 'running'
}
```

#### `tm.stop()`

`stop(): Promise<boolean>`

Stops the belt: forgets the ramp, ends a running program (`ended` with `'stop'`), and sends Stop **urgently**, ahead of
everything queued. If it did not get through, it is sent again, up to `STOP_ATTEMPTS` times, `STOP_RETRY_MS` apart. If
every attempt failed while still connected, it returns `false`, `state.stopFailed` becomes `true` and `stopFailed` is
sent: tell the person to stop the belt on the treadmill.

Stop is always allowed while connected (`state.controls.stop`).

```ts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') void tm.stop();
});

if (!(await tm.stop())) console.log('Could not stop: use the stop button or the safety key on the treadmill');
```

#### `tm.pause()`

`pause(): Promise<boolean>`

Like `stop`, but sends Pause (the treadmill keeps its distance and time). `ended` comes with `'pause'`. After a pause,
`start` resumes and ramps up to the speed it had.

```ts
if (tm.state.controls.pause) await tm.pause();
// later
await tm.start(); // back up to the speed before the pause
```

### Speed and incline

#### `tm.setSpeed(kmh, options?)`

`setSpeed(kmh: number, options?: { source?: CommandSource }): number | null`

Sets the speed to go to. Returns the target it will actually ramp to (inside the treadmill's range, capped by
`state.effectiveMax`, rounded to 0.1 km/h), or `null` if not connected, `kmh` is not a number or no speed is allowed. It does not wait for the belt.

How it gets there: in steps of at most `maxStep`, one command at most every `RAMP_INTERVAL_MS` (1.5 s), only while the
belt moves. Before Start, or while the belt still stands, the speed is held (`speed-held-until-moving`) and ramped to
once it moves.

`source` says who asked: `'manual'` (default: a button, a key, a preset) or `'program'` (a workout or route). A program's
speed is watched for a belt that stands still ([Standstill](LIBRARY.md#standstill)).

```ts
const target = tm.setSpeed(4.2);
if (target === null) console.log('no speed allowed now');
else console.log(`ramping to ${target} km/h`); // 4.2, or less if the limit is lower

// a workout step
tm.setSpeed(5, { source: 'program' });
```

#### `tm.changeSpeed(deltaKmh, options?)`

`changeSpeed(deltaKmh: number, options?: { source?: CommandSource }): number | null`

`setSpeed` relative to the current target (or, without one, the speed last sent). For + and − buttons.

```ts
document.querySelector('#faster')!.addEventListener('click', () => tm.changeSpeed(+0.1));
document.querySelector('#slower')!.addEventListener('click', () => tm.changeSpeed(-0.1));
```

#### `tm.setIncline(pct)`

`setIncline(pct: number): Promise<boolean>`

Sets the incline, clamped to the treadmill's range and rounded to 0.1 %. `false` if the treadmill cannot set an incline
(see [`inclineSupport`](#inclinesupportfeatures-range)), `pct` is not a number or the command failed. Unlike the speed,
there is no ramp: treadmills move the incline slowly by themselves.

```ts
const info = await tm.connect(adapter);
if (info.inclRange) await tm.setIncline(2.5);
```

### Limits and programs

#### `tm.setLimits(limits)`

`setLimits(limits: { speedLimit?: number; limitConfirmed?: boolean; maxStep?: number }): void`

Changes the limit or the step while running. Lowering the limit takes effect at once: a target above it comes down
(`limit-lowered`). A limit above 6 km/h needs `limitConfirmed: true` **in the same call**: the confirmation belongs to the
value it was given with.

```ts
tm.setLimits({ speedLimit: 4 });                        // lower: always taken
tm.setLimits({ speedLimit: 9, limitConfirmed: true });  // higher than 6: only with the person's yes
tm.setLimits({ maxStep: 0.2 });                         // gentler ramps
```

#### `tm.setProgramActive(active)`

`setProgramActive(active: boolean): void`

Tell the treadmill that a workout or route of yours is running. While it is, Start is locked (`state.controls.start` is
`false`), so nobody starts the belt a second time by hand. `false` ends the standstill watch.

The library ends nothing on its own: listen to `ended` and stop your program there.

```ts
tm.setProgramActive(true);
const off = tm.on('ended', () => {
  tm.setProgramActive(false);
  off();
  console.log('workout over');
});
```

### Raw commands

#### `tm.sendRaw(bytes, options?)`

`sendRaw(bytes: number[], options?: { confirmed?: boolean }): Promise<RawResult>`

Sends Control Point bytes as they are, for an experiment console. They are checked first, against the same limit, step and
interval as everything else: a Set Speed above the limit, a jump bigger than `maxStep`, speed commands closer than 1.5 s
or Heart Rate opcodes are not sent (`blocked`). A raw Start needs `confirmed: true` (`needs-confirmation`) because the belt
then starts without the start speed being set. A raw Stop or Pause ends a program (`ended` with `'console'`).

```ts
import { parseHexBytes } from 'ftms-treadmill';

const bytes = parseHexBytes('02 2c 01'); // Set Speed 3.00 km/h
if (bytes) {
  const r = await tm.sendRaw(bytes);
  if (r.action === 'blocked') console.log('blocked:', r.reason.code);
  if (r.action === 'needs-confirmation') console.log('ask the person first, then sendRaw(bytes, { confirmed: true })');
  if (r.action === 'sent') console.log(r.ok ? 'sent' : 'failed');
}
```

#### `RawResult`

| `action` | Means |
| --- | --- |
| `not-connected` | nothing sent |
| `blocked` | not sent; `reason` is a [`ConsoleBlock`](#consoleblock) |
| `needs-confirmation` | a raw Start; send again with `{ confirmed: true }` |
| `sent` | sent; `ok` says whether the treadmill took it |

### State

#### `tm.state`

`readonly state: TreadmillState`

A fresh snapshot (a `TreadmillState`) each time you read it. Read it whenever you draw; the [events](#events) tell you when to draw.

| Field | Meaning |
| --- | --- |
| `connected` | connected to a treadmill |
| `belt` | what the belt does: a [`BeltPhase`](#beltphase) |
| `controls` | `{ start, pause, stop }`: which buttons may be used now. **Stop is `true` whenever connected.** |
| `maybeRunning` | the belt may be moving; when in doubt `true` |
| `lastMeasured` | the last speed the treadmill reported, km/h |
| `target` | where the ramp is going, or `null` |
| `lastCommand` | `{ kmh, at }` of the last speed sent, or `null` |
| `ramping` | a ramp is under way |
| `speedLimit`, `limitConfirmed`, `maxStep` | the limits in force |
| `deviceRange` | `{ min, max }` the treadmill reported (1–12 before it did) |
| `effectiveMax` | the highest speed ever sent: the device maximum, capped by the limit |
| `inclineRange` | the incline range, or `null` |
| `controlLost` | the treadmill gave control to someone else; the next Start or Stop asks for it again |
| `stopFailed` | a Stop or Pause did not get through: the person has to stop the belt on the treadmill |
| `programActive` | what you told `setProgramActive` |

```ts
function draw() {
  const s = tm.state;
  (document.querySelector('#start') as HTMLButtonElement).disabled = !s.controls.start;
  (document.querySelector('#pause') as HTMLButtonElement).disabled = !s.controls.pause;
  (document.querySelector('#stop') as HTMLButtonElement).disabled = !s.controls.stop;
  document.querySelector('#speed')!.textContent = `${s.lastMeasured ?? 0} km/h → ${s.target ?? '–'}`;
  document.querySelector('#warning')!.toggleAttribute('hidden', !s.stopFailed);
}
for (const e of ['data', 'phase', 'target', 'stopFailed', 'disconnected'] as const) tm.on(e, draw);
setInterval(draw, 500); // the belt phase also changes with time (a start that is never measured ends)
```

#### `BeltPhase`

`'unknown' | 'standing' | 'starting' | 'running' | 'stopping'`

| Phase | Means |
| --- | --- |
| `unknown` | connected, nothing reported yet |
| `starting` | Start was sent, the belt does not move yet (until it is measured at `MOVING_KMH` or more, at most `START_MS`) |
| `running` | the belt moves |
| `stopping` | Stop or Pause was sent, or the treadmill reported a stop, and the belt still moves (at most `STOP_MAX_MS`) |
| `standing` | the belt stands (below `STANDING_KMH`) |

```ts
import type { BeltPhase } from 'ftms-treadmill';

const banner: Record<BeltPhase, string> = {
  unknown: '', standing: 'Ready', starting: 'Starting…', running: 'Walking', stopping: 'Stopping…',
};
tm.on('phase', p => { document.querySelector('#banner')!.textContent = banner[p]; });
```

### Events

#### `tm.on(event, listener)`

`on<E extends keyof TreadmillEventMap>(event: E, listener: (payload: TreadmillEventMap[E]) => void): () => void`

Adds a listener and returns the function that removes it. A listener that throws is reported a moment later (as an
uncaught error) but never gets in the way: a Stop goes out whatever your display does.

```ts
const off = tm.on('data', d => console.log(d.speed));
// later
off();
```

#### `TreadmillEventMap`

| Event | Payload | When |
| --- | --- | --- |
| `data` | [`TreadmillData`](#treadmilldata) | the treadmill reports (about once a second) |
| `heartRate` | `number` (bpm) | the Heart Rate service reports |
| `machineStatus` | `{ event: MachineEvent \| null; hex: string }` | the treadmill reports a change ([`MachineEvent`](#machineevent)) |
| `trainingStatus` | `{ hex; status: number \| null; text: string \| null }` | the treadmill's training status (e.g. `'Pre-Workout'`) |
| `controlResponse` | [`ControlPointResponse`](#controlpointresponse) | every answer to a command, also an OK |
| `notice` | [`Notice`](#notices) | something worth telling the person or a log |
| `log` | `string` | protocol lines (bytes sent, an answer that could not be read); not for people |
| `ended` | `{ reason: EndReason }` | the belt was stopped, or stopped by itself: end your program (once per run, see [`EndReason`](#endreason)) |
| `stopFailed` | `boolean` | a Stop or Pause did not get through (`true`), or later did (`false`) |
| `phase` | `BeltPhase` | after a start or stop request, after connecting; `state.belt` also moves with time |
| `target` | `undefined` | target, last command or ramp changed |
| `disconnected` | `{ wasRunning: boolean }` | the connection is gone; `wasRunning`: the belt may still be moving |

```ts
tm.on('data', d => console.log(`${d.speed} km/h, ${d.dist} m, ${d.time} s`));
tm.on('heartRate', bpm => console.log(`${bpm} bpm`));
tm.on('machineStatus', s => { if (s.event?.kind === 'control-lost') console.log('control lost'); });
tm.on('trainingStatus', s => console.log('training status:', s.text));
tm.on('controlResponse', r => { if (r.result !== 1) console.log(`op 0x${r.requestOp.toString(16)} refused: ${r.result}`); });
tm.on('notice', n => console.log('notice', n.code, n));
tm.on('log', line => console.debug(line));
tm.on('ended', e => console.log('belt ended:', e.reason));
tm.on('stopFailed', failed => { if (failed) alert('Stop the belt on the treadmill!'); });
tm.on('phase', p => console.log('phase', p));
tm.on('target', () => console.log('target', tm.state.target));
tm.on('disconnected', e => { if (e.wasRunning) alert('Connection lost. The belt may still be running!'); });
```

#### `EndReason`

| Reason | The belt ended because |
| --- | --- |
| `stop`, `pause` | you called `stop` or `pause` |
| `console` | a raw Stop or Pause was sent with `sendRaw` |
| `machine-stopped`, `machine-paused` | someone stopped or paused it on the treadmill (or its remote) |
| `safety-key` | the safety key was pulled |
| `standstill` | it stood still for 8 s while a program wanted it to move ([Standstill](LIBRARY.md#standstill)) |

`ended` comes **once per run of the belt**: your `stop()` sends `'stop'`, and when the treadmill then reports that it
stopped, no second `ended` follows (the `machineStatus` event still does). A new run starts with `start()`, a raw Start,
a start on the treadmill itself, the belt measured moving again after it stood, `setProgramActive(true)` or a new
connection; its end is told again. So a program you start always hears about its end.

#### `CommandSource`

`'program' | 'manual'`: who asked for a speed, see [`setSpeed`](#tmsetspeedkmh-options).

## Notices

The library has no texts. What it finds or what goes wrong comes as a `Notice`: a `code` and its values. Turn them into
words in your language; TypeScript checks that you handled every code if you switch over them:

```ts
import type { Notice } from 'ftms-treadmill';

function noticeText(n: Notice): string {
  switch (n.code) {
    case 'device': return `Device: ${n.name ?? 'unnamed'}`;
    case 'device-info': return `${n.field}: ${n.value}`;
    case 'not-subscribable': return `Characteristic 0x${n.uuid.toString(16)} cannot be subscribed`;
    case 'features': return `Reports: ${n.names.join(', ')}`;
    case 'controllable': return `Can be set: ${n.names.join(', ')}`;
    case 'features-unreadable': return 'Features could not be read';
    case 'speed-range': return `Speeds ${n.range.min}–${n.range.max} km/h`;
    case 'speed-range-unreadable': return 'Speed range could not be read';
    case 'incline-range': return `Incline ${n.range.min}–${n.range.max} %`;
    case 'incline-range-unreadable': return 'Incline range could not be read';
    case 'heart-rate': return n.available ? 'Heart rate available' : 'No heart rate';
    case 'write-dropped': return `Command dropped for a stop: ${n.bytes}`;
    case 'write-failed': return `Command failed: ${typeof n.error === 'string' ? n.error : n.error.message}`;
    case 'no-allowed-speed': return `No speed allowed (${n.min}–${n.max} km/h)`;
    case 'speed-held-until-moving': return `${n.kmh} km/h once the belt moves`;
    case 'ramp-aborted': return 'Speed change ended';
    case 'start-speed-failed': return 'Start speed could not be set';
    case 'speed-refused': return 'The treadmill refused the speed';
    case 'limit-lowered': return `Limit lowered: now ${n.kmh} km/h`;
    case 'limit-unconfirmed': return `${n.requested} km/h needs a confirmation; ${n.applied} km/h for now`;
    case 'console-set-speed-length': return 'Set Speed needs 3 bytes';
    case 'console-over-limit': return `${n.kmh} km/h is above the limit (${n.max})`;
    case 'console-jump': return `Jump ${n.from} → ${n.to} is bigger than ${n.maxStep} km/h`;
    case 'console-too-soon': return `Wait ${n.intervalMs} ms between speed commands`;
    case 'console-heart-rate': return 'Heart rate commands are not sent';
  }
}
tm.on('notice', n => console.log(noticeText(n)));
```

| Code | Values | When |
| --- | --- | --- |
| `device` | `name` | a device was chosen |
| `device-info` | `field` (`manufacturer`, `model`, `firmware`), `value` | read from Device Information |
| `not-subscribable` | `uuid` | Machine Status or Training Status cannot be subscribed (the treadmill works without) |
| `features`, `controllable` | `names` | what the treadmill reports and what it can be set to |
| `features-unreadable` | | its features could not be read |
| `speed-range`, `incline-range` | `range` | the ranges it accepts |
| `speed-range-unreadable`, `incline-range-unreadable` | | not readable; 1–12 km/h is assumed for the speed |
| `heart-rate` | `available` | whether it offers heart rate |
| `write-dropped` | `bytes` | a waiting command was dropped because a Stop or Pause went first |
| `write-failed` | `error`: a [`TreadmillErrorCode`](#treadmillerror) or `{ message }` | a command did not go through |
| `no-allowed-speed` | `min`, `max` | the limit is below the treadmill's lowest speed: nothing can be sent |
| `speed-held-until-moving` | `kmh` | the speed is held until the belt moves |
| `ramp-aborted` | | the ramp ended (the treadmill refused a step, the belt stopped) |
| `start-speed-failed` | | the lowest speed could not be set before Start (Start is sent anyway) |
| `speed-refused` | | the treadmill refused a speed |
| `limit-lowered` | `kmh` | the target came down to a lowered limit |
| `limit-unconfirmed` | `requested`, `applied` | a limit above 6 km/h without `limitConfirmed` |
| `console-…` | see [`ConsoleBlock`](#consoleblock) | a raw command was blocked |

### `ConsoleBlock`

Why `sendRaw` did not send: `{ code: 'console-set-speed-length' }`, `{ code: 'console-over-limit'; kmh; max }`,
`{ code: 'console-jump'; from; to; maxStep }`, `{ code: 'console-too-soon'; intervalMs }`, `{ code: 'console-heart-rate' }`.

```ts
const r = await tm.sendRaw([0x02, 0xe8, 0x03]); // 10.00 km/h
if (r.action === 'blocked' && r.reason.code === 'console-over-limit') console.log(`max ${r.reason.max} km/h`);
```

## Errors

### `TreadmillError`

`class TreadmillError extends Error { readonly code: TreadmillErrorCode }`

Why talking to the treadmill failed. The library catches it itself and reports it as `write-failed`; you meet it in that
notice's `error`, or when your own [adapter](#your-own-adapter) throws it.

### `TreadmillErrorCode`

`'no-gatt' | 'not-connected' | 'write-timeout'` (a write got no answer within `WRITE_TIMEOUT_MS`).

```ts
import { TreadmillError } from 'ftms-treadmill';

tm.on('notice', n => {
  if (n.code === 'write-failed' && n.error === 'write-timeout') console.log('the treadmill did not answer');
});
const e = new TreadmillError('not-connected');
console.log(e.name, e.code); // TreadmillError not-connected
```

## Adapters

The treadmill talks to Bluetooth through an adapter: Web Bluetooth in browsers, the simulator anywhere, or your own.

### `ftms-treadmill/web-bluetooth`

#### `WebBluetoothAdapter`

`new WebBluetoothAdapter()`, the only part of the library that touches `navigator.bluetooth`.

- `availability(): Promise<BleAvailability>`: `{ ok: true }`, or `{ ok: false, reason: 'no-api' }` (the browser has no Web
  Bluetooth) or `'no-adapter'` (no Bluetooth on this computer, or it is off).
- `requestDevice(services)`: opens the browser's picker; called by `connect`, not by you.

```ts
import { WebBluetoothAdapter } from 'ftms-treadmill/web-bluetooth';

const bt = new WebBluetoothAdapter();
const a = await bt.availability();
if (!a.ok) {
  console.log(a.reason === 'no-api' ? 'Use Chrome or Edge' : 'Switch Bluetooth on');
} else {
  document.querySelector('#connect')!.addEventListener('click', () => tm.connect(bt));
}
```

### `ftms-treadmill/sim`

#### `SimulatorAdapter`

`new SimulatorAdapter(options?: Partial<SimOptions>)`

A simulated FTMS treadmill that speaks real FTMS bytes, so everything above it runs exactly as with hardware. For demos,
tests and trying the library in Node. Its belt keeps running when the connection is lost, like a real one may.

- `belt`: the [`SimulatedBelt`](#simulatedbelt), to look at what the "hardware" does
- `simulateConnectionLoss()`: the connection drops (the belt keeps running)
- `pullSafetyKey()`: the belt stops at once and the treadmill reports it
- `dispose()`: disconnects and stops its timers (call it when done, e.g. at the end of a test)

```ts
import { createTreadmill } from 'ftms-treadmill';
import { SimulatorAdapter } from 'ftms-treadmill/sim';

const sim = new SimulatorAdapter({ speedRange: [0.5, 6, 0.1], countdownMs: 1000 });
const tm = createTreadmill();
tm.on('ended', e => console.log('ended:', e.reason)); // 'safety-key'

await tm.connect(sim);
await tm.start();
sim.pullSafetyKey();
sim.dispose();
```

#### `SimOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `name` | `'Walkflow Simulator'` | the advertised name |
| `speedRange` | `[1, 8, 0.1]` | min, max, step in km/h |
| `inclRange` | `[0, 10, 1]` | min, max, step in % |
| `incline` | `true` | `false`: a treadmill without incline |
| `heartRate` | `false` | offers a Heart Rate service |
| `countdownMs` | `3000` | the countdown after Start, before the belt moves |
| `accel` | `1` | how fast the belt changes speed, km/h per second |
| `tickMs`, `notifyMs` | `100`, `1000` | how often the belt moves on, how often it reports |
| `connectDelayMs`, `writeDelayMs` | `300`, `20` | how long connecting and a write take |
| `version` | `'dev'` | the firmware it reports |

#### `SimulatedBelt`

The simulator's "physical" belt (`sim.belt`): `state` (`'stopped' | 'countdown' | 'running' | 'paused'`), `speed`,
`target`, `incline`, `dist`, `elapsed`, `kcal`, `moving`. It lives on across connections. Read it in tests to check what
the treadmill would really do:

```ts
import { SimulatorAdapter } from 'ftms-treadmill/sim';

const sim = new SimulatorAdapter();
await tm.connect(sim);
await tm.start();
tm.setSpeed(3);
console.log(sim.belt.state, sim.belt.speed, sim.belt.target);
```

### Your own adapter

To use another Bluetooth stack (Node with a BLE library, React Native, a native shell), implement two small interfaces
and pass your adapter to `connect`. Services and characteristics are 16-bit UUIDs as numbers ([`Uuid`](#uuid)).

#### `BleAdapter`

| Member | |
| --- | --- |
| `kind: string` | a name for logs, e.g. `'noble'` |
| `availability(): Promise<BleAvailability>` | whether Bluetooth can be used |
| `requestDevice(optionalServices: Uuid[]): Promise<BleDevice>` | find the treadmill (the services it will use are given) |

#### `BleDevice`

| Member | |
| --- | --- |
| `name`, `connected` | |
| `connect(): Promise<void>`, `disconnect(): void` | |
| `onDisconnected(cb)` | call `cb` exactly once per connection, also after `disconnect()` |
| `read(service, characteristic): Promise<DataView>` | |
| `subscribe(service, characteristic, cb): Promise<void>` | register `cb` **before** enabling notifications |
| `write(service, characteristic, data: Uint8Array): Promise<void>` | write **with response**; resolve once the device answered |

```ts
import { createTreadmill, type BleAdapter, type BleAvailability, type BleDevice, type Uuid } from 'ftms-treadmill';

/** A device behind some other Bluetooth library: fill in the calls of that library */
class MyDevice implements BleDevice {
  name: string | undefined = 'My treadmill';
  connected = false;
  private onGone: (() => void) | null = null;
  async connect() { this.connected = true; }
  disconnect() { this.connected = false; this.onGone?.(); }
  onDisconnected(cb: () => void) { this.onGone = cb; }
  async read(service: Uuid, characteristic: Uuid): Promise<DataView> {
    throw new Error(`read 0x${characteristic.toString(16)} of 0x${service.toString(16)}: not implemented`);
  }
  async subscribe(_service: Uuid, _characteristic: Uuid, _cb: (dv: DataView) => void) { /* register, then enable */ }
  async write(_service: Uuid, _characteristic: Uuid, _data: Uint8Array) { /* write with response */ }
}

class MyAdapter implements BleAdapter {
  readonly kind = 'my-stack';
  async availability(): Promise<BleAvailability> { return { ok: true }; }
  async requestDevice(_optionalServices: Uuid[]): Promise<BleDevice> { return new MyDevice(); }
}

await createTreadmill().connect(new MyAdapter());
```

#### `BleAvailability`

`{ ok: true } | { ok: false; reason: 'no-api' | 'no-adapter' }`

#### `Uuid`

`number`: a 16-bit Bluetooth UUID, e.g. `0x1826` for the Fitness Machine Service.

## Helpers and constants

### `inclineSupport(features, range)`

`inclineSupport(features: Features | undefined, range: Range | undefined): InclineSupport`

What the treadmill can do with the incline: `settable` (it accepts Set Inclination: show incline buttons) and `reported`
(it reports the incline: show the figure). Asks the treadmill's features; nothing is assumed.

```ts
import { inclineSupport } from 'ftms-treadmill';

const info = await tm.connect(adapter);
const incline = inclineSupport(info.features, info.inclRange);
document.querySelector('#incline-buttons')!.toggleAttribute('hidden', !incline.settable);
document.querySelector('#incline-figure')!.toggleAttribute('hidden', !incline.reported);
```

### `InclineSupport`

`{ settable: boolean; reported: boolean }`

### `clampIncline(pct, range)`

`clampIncline(pct: number, range: Range | undefined): number`

The incline that would be sent: rounded to 0.1 % and inside the range. `setIncline` does this itself; use it to show the
value before it is sent.

```ts
import { clampIncline } from 'ftms-treadmill';

console.log(clampIncline(12.34, { min: 0, max: 10, step: 0.5 })); // 10
console.log(clampIncline(2.34, undefined));                      // 2.3
```

### `parseHexBytes(text)`

`parseHexBytes(text: string): number[] | null`

Strict hex bytes for `sendRaw`: one or two hex digits per byte, separated by spaces or commas; `null` for anything else.

```ts
import { parseHexBytes } from 'ftms-treadmill';

console.log(parseHexBytes('08 01'));   // [8, 1]
console.log(parseHexBytes('0x08 01')); // null
```

### Constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_SPEED_LIMIT` | 6 | km/h, the limit unless you set one |
| `LIMIT_MIN`, `LIMIT_MAX` | 1, 20 | km/h, the range of a limit |
| `LIMIT_CONFIRM_ABOVE` | 6 | km/h; a higher limit needs `limitConfirmed` |
| `DEFAULT_MAX_STEP` | 0.5 | km/h per command while ramping |
| `MAX_STEP_MIN`, `MAX_STEP_MAX` | 0.1, 1 | km/h, the range of `maxStep` |
| `RAMP_INTERVAL_MS` | 1500 | at most one speed command this often |
| `STOP_ATTEMPTS` | 3 | how often a Stop or Pause is sent before `stopFailed` |
| `STOP_RETRY_MS` | 300 | the wait between two attempts |
| `WRITE_TIMEOUT_MS` | 5000 | a write without an answer is given up after this |
| `START_MS` | 4500 | the longest `starting` phase without a measured belt |
| `STOP_MAX_MS` | 20000 | the longest `stopping` phase |
| `MOVING_KMH` | 0.3 | the belt counts as moving from this speed |
| `STANDING_KMH` | 0.1 | the belt counts as standing below this speed |

```ts
import { DEFAULT_SPEED_LIMIT, LIMIT_CONFIRM_ABOVE, LIMIT_MAX, LIMIT_MIN } from 'ftms-treadmill';

const slider = document.querySelector('#limit') as HTMLInputElement;
slider.min = String(LIMIT_MIN);
slider.max = String(LIMIT_MAX);
slider.value = String(DEFAULT_SPEED_LIMIT);
slider.addEventListener('change', () => {
  const kmh = Number(slider.value);
  const confirmed = kmh <= LIMIT_CONFIRM_ABOVE || confirm(`Allow up to ${kmh} km/h? Only if you can walk safely at it.`);
  tm.setLimits({ speedLimit: confirmed ? kmh : LIMIT_CONFIRM_ABOVE, limitConfirmed: confirmed });
});
```

## Types from the protocol

These come with the events and `ConnectResult`; they are exported from `ftms-treadmill` as types, and with their parsers
from [`ftms-treadmill/protocol`](#ftms-treadmillprotocol).

### `TreadmillData`

What the treadmill reports; a field is there only if the treadmill sends it. `speed`, `avgSpeed` (km/h), `dist` (m),
`incl` (%), `rampAngle` (°), `elevationGainPos`, `elevationGainNeg` (m), `pace`, `avgPace` (km/min), `kcal`, `kcalPerHour`,
`kcalPerMin`, `hr` (bpm, 0 = none), `met`, `time` (s).

```ts
tm.on('data', d => {
  if (d.speed !== undefined) document.querySelector('#speed')!.textContent = d.speed.toFixed(1);
  if (d.dist !== undefined) document.querySelector('#distance')!.textContent = `${(d.dist / 1000).toFixed(2)} km`;
});
```

### `Features`

`{ machine: number; target: number; machineNames: string[]; targetNames: string[] }`: the FTMS feature bits, and their
names (`machineNames`: what it reports, `targetNames`: what can be set).

### `Range`

`{ min: number; max: number; step: number }`

### `MachineEvent`

`{ kind: 'reset' | 'stopped' | 'paused' | 'safety-key' | 'started' | 'control-lost' }`, `{ kind: 'target-speed'; kmh }`,
`{ kind: 'target-incline'; pct }` or `{ kind: 'other'; op }`. The library already acts on `stopped`, `paused`,
`safety-key` (the ramp ends, `ended` is sent) and `control-lost` (`state.controlLost`).

```ts
tm.on('machineStatus', s => {
  if (s.event?.kind === 'target-speed') console.log(`treadmill now aims for ${s.event.kmh} km/h`);
});
```

### `ControlPointResponse`

`{ requestOp: number; result: number }`: the answer to a command. `result` 1 is success; 2 not supported, 3 invalid
parameter, 4 failed, 5 control not permitted.

## `ftms-treadmill/protocol`

The FTMS bytes on their own, for anyone who drives the treadmill themselves. **Nothing here keeps a belt safe**: no limit,
no ramp, no retried stop. Use `createTreadmill` unless you have a reason not to.

| Export | What |
| --- | --- |
| `FTMS_SERVICE`, `HR_SERVICE`, `DEVINFO_SERVICE` | service UUIDs (`0x1826`, `0x180d`, `0x180a`) |
| `CH`, `DEVINFO_CH` | characteristic UUIDs by name (`CH.control`, `CH.treadmillData`, …) |
| `OP`, `OP_NAMES` | Control Point opcodes and their names |
| `FEAT_MACHINE`, `FEAT_TARGET` | names of the feature bits |
| `cmdRequestControl()`, `cmdStart()`, `cmdStop()`, `cmdPause()` | commands as `Uint8Array` |
| `cmdSetSpeed(kmh)`, `cmdSetInclination(pct)` | commands with a value; throw a `RangeError` outside what FTMS can encode |
| `decodeSetSpeed(bytes)` | the speed in a raw Set Speed, or `null` |
| `parseTreadmillData(dv)` | Treadmill Data → `TreadmillData` (keeps what it read of a short packet) |
| `buildTreadmillData(d)` | the other way round, for simulators and tests |
| `parseHeartRate(dv)` | Heart Rate Measurement → bpm |
| `parseFeatures(dv)`, `parseSpeedRange(dv)`, `parseInclinationRange(dv)` | what the treadmill can do |
| `parseMachineStatus(dv)`, `parseTrainingStatus(dv)`, `parseControlPointResponse(dv)` | what it reports and answers |
| `hex(data)`, `toBytes(data)`, `dataView(bytes)`, `bitNames(value, names)` | helpers for bytes |

```ts
import { cmdSetSpeed, dataView, decodeSetSpeed, hex, parseTreadmillData } from 'ftms-treadmill/protocol';

console.log(hex(cmdSetSpeed(3.5)));           // 02 5e 01
console.log(decodeSetSpeed([0x02, 0x5e, 0x01])); // 3.5
console.log(parseTreadmillData(dataView([0x04, 0x00, 0x5e, 0x01, 0x10, 0x27, 0x00]))); // { speed: 3.5, dist: 10000 }
```

## Recipes

### A complete page

```ts
import { createTreadmill } from 'ftms-treadmill';
import { WebBluetoothAdapter } from 'ftms-treadmill/web-bluetooth';
import { SimulatorAdapter } from 'ftms-treadmill/sim';

const tm = createTreadmill({ speedLimit: 6 });
const $ = (id: string) => document.getElementById(id) as HTMLButtonElement;

function draw() {
  const s = tm.state;
  $('start').disabled = !s.controls.start;
  $('pause').disabled = !s.controls.pause;
  $('stop').disabled = !s.controls.stop;
  $('speed').textContent = s.lastMeasured?.toFixed(1) ?? '–';
}
for (const e of ['data', 'phase', 'target', 'stopFailed', 'disconnected'] as const) tm.on(e, draw);
tm.on('stopFailed', failed => { if (failed) alert('Stop the belt on the treadmill!'); });
tm.on('disconnected', e => { if (e.wasRunning) alert('Connection lost. The belt may still be running!'); });

$('connect').onclick = () => tm.connect(new WebBluetoothAdapter()).then(draw, e => console.log(e));
$('demo').onclick = () => tm.connect(new SimulatorAdapter()).then(draw);
$('start').onclick = () => tm.start();
$('pause').onclick = () => tm.pause();
$('stop').onclick = () => tm.stop();
$('faster').onclick = () => tm.changeSpeed(+0.5);
$('slower').onclick = () => tm.changeSpeed(-0.5);
document.addEventListener('keydown', e => { if (e.key === 'Escape' || e.key === ' ') void tm.stop(); });
```

### A workout

The library drives the belt; the program is yours. Mark the speeds as `'program'`, lock Start while it runs, and end it
on `ended`:

```ts
const steps = [{ kmh: 3, ms: 60_000 }, { kmh: 4.5, ms: 120_000 }, { kmh: 3, ms: 60_000 }];

async function workout(): Promise<void> {
  let over = false;
  const off = tm.on('ended', () => { over = true; });
  tm.setProgramActive(true);
  try {
    if (!(await tm.start())) return;
    for (const step of steps) {
      if (over) return;
      tm.setSpeed(step.kmh, { source: 'program' });
      await new Promise(r => setTimeout(r, step.ms));
    }
    await tm.stop();
  } finally {
    off();
    tm.setProgramActive(false);
  }
}
```

### Tests without a treadmill

The simulator and a fake clock make tests fast and repeatable (here with Vitest; any runner works):

```ts
import { expect, it } from 'vitest';
import { createTreadmill } from 'ftms-treadmill';
import { SimulatorAdapter } from 'ftms-treadmill/sim';

it('never sends more than the limit', async () => {
  const sim = new SimulatorAdapter({ countdownMs: 0, connectDelayMs: 0, writeDelayMs: 0 });
  const tm = createTreadmill({ speedLimit: 4 });
  await tm.connect(sim);
  expect(tm.setSpeed(7)).toBe(4);
  sim.dispose();
});
```

### Node

The core and the simulator run in Node 20 or later; try it with
[`examples/simulator.ts`](../examples/simulator.ts) (`node examples/simulator.ts` after `npm run build`). For a real
treadmill in Node, write an [adapter](#your-own-adapter) for a Bluetooth library such as `@abandonware/noble`.
