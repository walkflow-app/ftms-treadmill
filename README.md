# ftms-treadmill

Controls a treadmill that speaks **FTMS** (Bluetooth Fitness Machine Service) and keeps the belt safe while doing it: a
speed limit that is never exceeded, speed changes in small steps, and a Stop that always gets through. It has no user
interface, no storage and no texts of its own. You draw the buttons; it drives the belt.

It is the treadmill control of [Walkflow](https://github.com/walkflow-app/walkflow), tested on real treadmills (a sPad 500
so far). Version 0.x: the API may still change in a minor version. Each change is listed in the changelog.

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
5. When the treadmill stops by itself (its button, the safety key), the ramp is forgotten and `ended` is sent.
6. No method throws during a session (only `connect`); a failed command returns `false` and sends a notice.

The full API, the belt phases, every notice code and the reasons behind each rule are in
[docs/LIBRARY.md](https://github.com/walkflow-app/walkflow/blob/main/docs/LIBRARY.md).

## License

MIT
