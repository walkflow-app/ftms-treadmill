// Drives the simulated treadmill from Node: connect, start, ramp to 2 km/h, stop. Shows what the library reports on the way.
// Run it with `npm run example` (builds first; Node 22.18 or later runs TypeScript as it is). CI runs it too, so it keeps working.
import { createTreadmill } from 'ftms-treadmill';
import { SimulatorAdapter } from 'ftms-treadmill/sim';

const sim = new SimulatorAdapter({ countdownMs: 500, connectDelayMs: 50, notifyMs: 250 });
const tm = createTreadmill({ speedLimit: 4, maxStep: 0.5 });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`, ...a);

tm.on('notice', n => log('notice', n.code));
tm.on('phase', p => log('phase', p));
tm.on('ended', e => log('ended', e.reason));

const info = await tm.connect(sim);
log('connected to', info.deviceName, 'speeds', info.speedRange);

await tm.start();
log('ramping to', tm.setSpeed(2), 'km/h');

// Wait until the belt is measured at 2 km/h (at most 15 s)
while (tm.state.lastMeasured !== 2) {
  if (Date.now() - t0 > 15_000) throw new Error(`belt at ${tm.state.lastMeasured} km/h, expected 2`);
  await sleep(100);
}
log('belt at', tm.state.lastMeasured, 'km/h');

if (!(await tm.stop())) throw new Error('stop failed');
while (tm.state.belt !== 'standing') await sleep(100);
log('belt', tm.state.belt);

tm.disconnect();
sim.dispose();
