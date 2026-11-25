import { describe, expect, it, vi } from 'vitest';
import { buildTreadmillData, dataView, hex } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import { DEFAULT_SPEED_LIMIT } from '../safety/safety.ts';
import type { BleAdapter, BleDevice, Uuid } from './ble.ts';
import { createTreadmill, type TreadmillOptions } from './treadmill.ts';

/** A treadmill with Control Point, Treadmill Data, Machine Status, speed range 1–8 km/h and incline 0–10 % */
class FakeTreadmill implements BleDevice {
  name = 'FAKE';
  connected = false;
  writes: string[] = [];
  subs = new Map<string, (dv: DataView) => void>();
  writeImpl: (data: Uint8Array) => Promise<void> = async () => {};
  private disconnectCb: (() => void) | null = null;
  readonly readable = new Map<string, number[]>([
    // Features: machine = Inclination (bit 3); target = Speed (bit 0), Inclination (bit 1)
    ['1826/2acc', [0x08, 0, 0, 0, 0x03, 0, 0, 0]],
    ['1826/2ad4', [100, 0, 0x20, 0x03, 10, 0]],
    ['1826/2ad5', [0, 0, 100, 0, 10, 0]],
  ]);

  async connect() { this.connected = true; }
  disconnect() { this.connected = false; const cb = this.disconnectCb; this.disconnectCb = null; cb?.(); }
  onDisconnected(cb: () => void) { this.disconnectCb = cb; }
  async read(s: Uuid, c: Uuid) {
    const v = this.readable.get(`${s.toString(16)}/${c.toString(16)}`);
    if (!v) throw new Error('not there');
    return dataView(v);
  }
  async subscribe(s: Uuid, c: Uuid, cb: (dv: DataView) => void) {
    const key = `${s.toString(16)}/${c.toString(16)}`;
    if (!['1826/2ad9', '1826/2acd', '1826/2ada'].includes(key)) throw new Error('not there');
    this.subs.set(key, cb);
  }
  async write(_s: Uuid, _c: Uuid, data: Uint8Array) {
    await this.writeImpl(data);
    this.writes.push(hex(data));
  }
  /** The treadmill reports its speed */
  speed(kmh: number) { this.subs.get('1826/2acd')!(dataView(buildTreadmillData({ speed: kmh }))); }
  machineStatus(...bytes: number[]) { this.subs.get('1826/2ada')!(dataView(bytes)); }
  /** The treadmill answers a command */
  answer(op: number, result: number) { this.subs.get('1826/2ad9')!(dataView([0x80, op, result])); }
}

let clock = 0;
async function rig(opts: TreadmillOptions = {}) {
  const dev = new FakeTreadmill();
  const adapter: BleAdapter = { kind: 'fake', availability: async () => ({ ok: true }), requestDevice: async () => dev };
  clock = 0;
  const tm = createTreadmill({ clock: { now: () => clock, wait: async () => {} }, ...opts });
  const notices: Notice[] = [];
  tm.on('notice', n => notices.push(n));
  const info = await tm.connect(adapter);
  dev.writes = [];
  return { tm, dev, adapter, notices, info };
}

describe('connecting', () => {
  it('reads the treadmill, asks for control and takes over its speed range', async () => {
    const dev = new FakeTreadmill();
    const tm = createTreadmill();
    const info = await tm.connect({ kind: 'fake', availability: async () => ({ ok: true }), requestDevice: async () => dev });
    expect(info.speedRange).toEqual({ min: 1, max: 8, step: 0.1 });
    expect(dev.writes).toEqual(['00']);
    expect(tm.state.connected).toBe(true);
    expect(tm.state.deviceRange).toEqual({ min: 1, max: 8 });
    expect(tm.state.effectiveMax).toBe(DEFAULT_SPEED_LIMIT);
  });

  it('a lost connection says whether the belt may have been running, and forgets the belt', async () => {
    const { tm, dev } = await rig();
    const lost = vi.fn();
    tm.on('disconnected', lost);
    dev.speed(3);
    dev.disconnect();
    expect(lost).toHaveBeenCalledWith({ wasRunning: true });
    expect(tm.state.connected).toBe(false);
    expect(tm.state.maybeRunning).toBe(false);
    expect(tm.state.controls).toEqual({ start: false, pause: false, stop: false });
  });
});

describe('connect() called twice (#27 C)', () => {
  /** A device whose connect() hangs until it is let go, then succeeds or fails */
  function slowAdapter(dev: FakeTreadmill) {
    let go!: (ok: boolean) => void;
    const gate = new Promise<boolean>(r => { go = r; });
    dev.connect = async () => { if (!(await gate)) throw new Error('gone'); dev.connected = true; };
    const adapter: BleAdapter = { kind: 'slow', availability: async () => ({ ok: true }), requestDevice: async () => dev };
    return { adapter, go };
  }
  const fastAdapter = (dev: FakeTreadmill): BleAdapter => ({ kind: 'fast', availability: async () => ({ ok: true }), requestDevice: async () => dev });

  it('the first attempt failing late does not take the connection of the second', async () => {
    const tm = createTreadmill({ clock: { now: () => 0, wait: async () => {} } });
    const slow = slowAdapter(new FakeTreadmill());
    const first = tm.connect(slow.adapter).catch(() => 'failed');
    const dev = new FakeTreadmill();
    await tm.connect(fastAdapter(dev));
    slow.go(false);
    expect(await first).toBe('failed');
    expect(tm.state.connected).toBe(true);
    dev.writes = [];
    expect(await tm.stop()).toBe(true);
    expect(dev.writes).toEqual(['08 01']);
  });

  it('the first attempt succeeding late does not change what the second one found out', async () => {
    const tm = createTreadmill({ clock: { now: () => 0, wait: async () => {} } });
    const slowDev = new FakeTreadmill();
    slowDev.readable.set('1826/2ad4', [100, 0, 0xe8, 0x03, 10, 0]);
    const slow = slowAdapter(slowDev);
    const first = tm.connect(slow.adapter).catch(() => 'superseded');
    const dev = new FakeTreadmill();
    await tm.connect(fastAdapter(dev));
    slow.go(true);
    await first;
    expect(tm.state.connected).toBe(true);
    expect(tm.state.deviceRange).toEqual({ min: 1, max: 8 });
    expect(slowDev.connected).toBe(false);
  });
});

describe('the speed limit (promise 1)', () => {
  it('never commands above the limit', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    dev.speed(3.8);
    expect(tm.setSpeed(7)).toBe(4);
    // Waits for the write (#28 G: asserting at once passed on an empty list)
    await vi.waitFor(() => expect(dev.writes).toContain('02 90 01'));
    expect(dev.writes.filter(w => w.startsWith('02'))).toEqual(['02 90 01']);
  });

  it('above 6 km/h only with a confirmation, otherwise 6 km/h and a notice', async () => {
    expect(createTreadmill({ speedLimit: 8 }).state.speedLimit).toBe(6);
    const { tm, notices } = await rig();
    tm.setLimits({ speedLimit: 8 });
    expect(tm.state.speedLimit).toBe(6);
    expect(notices).toContainEqual({ code: 'limit-unconfirmed', requested: 8, applied: 6 });
    tm.setLimits({ speedLimit: 8, limitConfirmed: true });
    expect(tm.state.speedLimit).toBe(8);
    expect(tm.state.effectiveMax).toBe(8);
  });

  it('the confirmation belongs to the value it came with', async () => {
    const { tm } = await rig({ speedLimit: 8, limitConfirmed: true });
    expect(tm.state.speedLimit).toBe(8);
    tm.setLimits({ speedLimit: 7 });
    expect(tm.state.speedLimit).toBe(6);
  });

  it('lowering never needs it, and nonsense keeps the limit in force (#28 D)', async () => {
    const { tm } = await rig();
    tm.setLimits({ speedLimit: 3 });
    expect(tm.state.speedLimit).toBe(3);
    tm.setLimits({ speedLimit: Number.NaN });
    expect(tm.state.speedLimit).toBe(3);
    tm.setLimits({ speedLimit: Number.POSITIVE_INFINITY, limitConfirmed: true });
    expect(tm.state.speedLimit).toBe(3);
  });

  it('nonsense given when the treadmill is made is the default limit', () => {
    expect(createTreadmill({ speedLimit: Number.NaN }).state.speedLimit).toBe(DEFAULT_SPEED_LIMIT);
  });

  it('a lowered limit is reached in one command, not in steps: the exception to promise 2 (#28 B)', async () => {
    const { tm, dev } = await rig();
    dev.speed(6); // running at 6 (started on the treadmill)
    tm.setLimits({ speedLimit: 1 });
    await vi.waitFor(() => expect(dev.writes).toEqual(['02 64 00']));
  });

  it('a queued speed command is withdrawn when the treadmill reports a stop (#28 F)', async () => {
    const { tm, dev } = await rig();
    dev.speed(2);
    let release!: () => void;
    dev.writeImpl = () => new Promise(r => { release = r; });
    void tm.setIncline(2); // holds the queue
    tm.setSpeed(2.5); // waits behind it
    dev.machineStatus(0x02, 0x01);
    dev.writeImpl = async () => {};
    release();
    await vi.waitFor(() => expect(dev.writes).toEqual(['03 14 00']));
    await new Promise(r => setTimeout(r, 10));
    expect(dev.writes).toEqual(['03 14 00']);
  });

  it('a ramp step waiting in the queue is withdrawn when the limit is lowered below it, and the lowered limit goes out instead (#34)', async () => {
    const { tm, dev, notices } = await rig();
    dev.speed(4);
    let release!: () => void;
    dev.writeImpl = () => new Promise(r => { release = r; });
    void tm.setIncline(2); // holds the queue
    tm.setSpeed(5.5); // the step 4.5 (02 c2 01) waits behind it
    await new Promise(r => setTimeout(r, 0));
    tm.setLimits({ speedLimit: 4 }); // the limit is lowered while the step waits
    dev.writeImpl = async () => {};
    release();
    await vi.waitFor(() => expect(dev.writes).toContain('02 90 01'));
    await new Promise(r => setTimeout(r, 10));
    expect(dev.writes).toEqual(['03 14 00', '02 90 01']);
    expect(notices).toContainEqual({ code: 'write-dropped', bytes: '02 c2 01' });
    expect(notices).not.toContainEqual({ code: 'ramp-aborted' });
    expect(tm.state.target).toBe(4);
  });

  it('a stop reported while a start waits in the queue does not withdraw the start (#28 F)', async () => {
    const { tm, dev } = await rig();
    let release!: () => void;
    dev.writeImpl = () => new Promise(r => { release = r; });
    void tm.setIncline(2); // holds the queue
    const started = tm.start();
    await new Promise(r => setTimeout(r, 0));
    dev.machineStatus(0x02, 0x01); // the echo of an earlier stop
    dev.writeImpl = async () => {};
    release();
    await started;
    expect(dev.writes.slice(0, 4)).toEqual(['03 14 00', '00', '02 64 00', '07']);
  });

  it('forgets the speed asked for when the connection ends: a new one does not ramp to it (#28 E)', async () => {
    const { tm, dev, adapter } = await rig();
    dev.speed(2);
    tm.setSpeed(3);
    dev.disconnect();
    await tm.connect(adapter);
    dev.writes = [];
    expect(await tm.start()).toBe(true);
    dev.speed(1);
    await new Promise(r => setTimeout(r, 10));
    expect(dev.writes.filter(w => w.startsWith('02'))).toEqual(['02 64 00']);
    expect(tm.state.target).toBeNull();
  });

  it('a raw Set Speed above the limit is blocked', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    expect(await tm.sendRaw([0x02, 0xf4, 0x01])).toEqual({ action: 'blocked', reason: { code: 'console-over-limit', kmh: 5, max: 4 } });
    expect(dev.writes).toEqual([]);
  });

  it('a lower limit brings the target down and says so', async () => {
    const { tm, dev, notices } = await rig();
    dev.speed(5);
    tm.setSpeed(5);
    tm.setLimits({ speedLimit: 4 });
    expect(tm.state.target).toBe(4);
    expect(notices).toContainEqual({ code: 'limit-lowered', kmh: 4 });
  });
});

describe('start (promise 3) and stop (promise 4)', () => {
  it('sets the lowest speed before Start', async () => {
    const { tm, dev } = await rig();
    expect(await tm.start()).toBe(true);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
    expect(tm.state.belt).toBe('starting');
  });

  it('a start speed that could not be written: no Start, false, a notice', async () => {
    const { tm, dev, notices } = await rig();
    dev.writeImpl = async d => { if (hex(dataView(Array.from(d))) === '02 64 00') throw new Error('GATT busy'); };
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual(['00']);
    expect(notices).toContainEqual({ code: 'start-speed-failed' });
    expect(tm.state.belt).not.toBe('starting');
  });

  it('a start speed the treadmill refuses (80 02 03) between Set Speed and Start: no Start', async () => {
    const { tm, dev, notices } = await rig();
    dev.writeImpl = async d => { if (d[0] === 0x02) queueMicrotask(() => dev.answer(0x02, 3)); };
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual(['00', '02 64 00']);
    expect(notices).toContainEqual({ code: 'speed-refused' });
    expect(notices).toContainEqual({ code: 'start-speed-failed' });
  });

  it('a start speed the treadmill accepts (80 02 01) is followed by Start', async () => {
    const { tm, dev } = await rig();
    dev.writeImpl = async d => { if (d[0] === 0x02) queueMicrotask(() => dev.answer(0x02, 1)); };
    expect(await tm.start()).toBe(true);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
  });

  it('an answer that arrives before the start speed was written is not its answer: a stray 80 02 01, then the refusal: no Start', async () => {
    const { tm, dev } = await rig();
    dev.writeImpl = async d => {
      if (d[0] === 0x00) dev.answer(0x02, 1); // a late success of an earlier Set Speed, while Control is asked for
      if (d[0] === 0x02) queueMicrotask(() => dev.answer(0x02, 3));
    };
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual(['00', '02 64 00']);
  });

  it('the answer to a raw Set Speed that was written before the start speed is not the answer to it: success for the console, refusal for the start: no Start', async () => {
    const { tm, dev } = await rig();
    let raw: Promise<unknown> | undefined;
    dev.writeImpl = async d => {
      if (d[0] === 0x00) raw = tm.sendRaw([0x02, 0x6e, 0x00]); // goes out between Request Control and the start speed
      // the console's success comes late, together with the refusal of the start speed that was written after it
      if (d[0] === 0x02 && d[1] === 0x64) queueMicrotask(() => { dev.answer(0x02, 1); dev.answer(0x02, 3); });
    };
    expect(await tm.start()).toBe(false);
    expect(await raw).toEqual({ action: 'sent', ok: true });
    expect(dev.writes).toEqual(['00', '02 6e 00', '02 64 00']);
  });

  it('a raw Set Speed whose write failed leaves nothing behind: the refusal of the start speed still blocks Start', async () => {
    const { tm, dev } = await rig();
    dev.writeImpl = async d => {
      if (d[0] === 0x02 && d[1] === 0x6e) throw new Error('GATT busy');
      if (d[0] === 0x02 && d[1] === 0x64) queueMicrotask(() => dev.answer(0x02, 3));
    };
    await tm.sendRaw([0x02, 0x6e, 0x00]);
    expect(await tm.start()).toBe(false);
    expect(dev.writes).not.toContain('07');
  });

  it('an earlier Set Speed that was answered more than 1 s late: its success is not the answer to the start speed, whose refusal follows: no Start', async () => {
    const { tm, dev } = await rig();
    expect(await tm.sendRaw([0x02, 0x6e, 0x00])).toEqual({ action: 'sent', ok: true }); // no answer in time
    clock = 1200;
    dev.writeImpl = async d => {
      // the late success of the console's Set Speed, then the refusal of the start speed
      if (d[0] === 0x02 && d[1] === 0x64) queueMicrotask(() => { dev.answer(0x02, 1); dev.answer(0x02, 3); });
    };
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual(['02 6e 00', '00', '02 64 00']);
  });

  it('after a failed start the speed asked for is kept: the next start ramps up to it again', async () => {
    const { tm, dev } = await rig();
    dev.speed(0);
    tm.setSpeed(3);
    dev.writeImpl = async d => { if (d[0] === 0x02) queueMicrotask(() => dev.answer(0x02, 3)); };
    expect(await tm.start()).toBe(false);
    dev.writeImpl = async () => {};
    dev.writes = [];
    expect(await tm.start()).toBe(true);
    expect(tm.state.target).toBe(3);
  });

  it('a treadmill that gives no answer to Set Speed delays Start by up to SPEED_ANSWER_MS (1 s), then Start goes out', async () => {
    const waits: number[] = [];
    const dev = new FakeTreadmill();
    const tm = createTreadmill({ clock: { now: () => 0, wait: async ms => { waits.push(ms); } } });
    await tm.connect({ kind: 'fake', availability: async () => ({ ok: true }), requestDevice: async () => dev });
    dev.writes = [];
    expect(await tm.start()).toBe(true);
    expect(waits).toContain(1000);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
  });

  it('a limit below the lowest speed of the treadmill: no Start', async () => {
    const dev = new FakeTreadmill();
    dev.readable.set('1826/2ad4', [200, 0, 0x20, 0x03, 10, 0]); // lowest speed 2 km/h
    const tm = createTreadmill({ clock: { now: () => 0, wait: async () => {} }, speedLimit: 1.5 });
    const notices: Notice[] = [];
    tm.on('notice', n => notices.push(n));
    await tm.connect({ kind: 'fake', availability: async () => ({ ok: true }), requestDevice: async () => dev });
    dev.writes = [];
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual(['00']);
    expect(notices).toContainEqual({ code: 'no-allowed-speed', min: 2, max: 1.5 });
    expect(notices).toContainEqual({ code: 'start-speed-failed' });
  });

  it('a treadmill that stopped reporting after a last slow reading can be started again', async () => {
    const { tm, dev } = await rig();
    dev.speed(0.5);
    clock = 6000;
    expect(await tm.start()).toBe(true);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
  });

  it('a late answer after the wait is over has no effect, and nobody is left listening', async () => {
    const { tm, dev } = await rig();
    expect(await tm.start()).toBe(true); // no answer: the clock's wait ends at once
    dev.answer(0x02, 3);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
  });

  it('on a moving belt: no Set Speed below the speed of the belt, no Start (the readings may be old)', async () => {
    const { tm, dev, notices } = await rig();
    await tm.start();
    dev.speed(5);
    dev.writes = [];
    clock = 60_000;
    expect(await tm.start()).toBe(false);
    expect(dev.writes).toEqual([]);
    expect(notices).toContainEqual({ code: 'start-belt-moving' });
    expect(tm.state.belt).not.toBe('starting');
  });

  it.each(['stop', 'pause'] as const)('after %s, Start ramps up again to the speed the belt had, from the lowest speed', async how => {
    const { tm, dev } = await rig();
    dev.speed(3.5);
    tm.setSpeed(3.5);
    clock = 10_000;
    await tm[how]();
    expect(tm.state.target).toBe(null);
    dev.speed(0);
    clock = 20_000;
    dev.writes = [];
    expect(await tm.start()).toBe(true);
    expect(dev.writes).toEqual(['00', '02 64 00', '07']);
    expect(tm.state.target).toBe(3.5);
    // Nothing more until the belt moves; then the ramp, step by step
    clock = 22_000;
    dev.speed(1);
    await vi.waitFor(() => expect(dev.writes.at(-1)).toBe('02 96 00'));
  });

  it('a speed chosen after the stop counts, not the one before', async () => {
    const { tm, dev } = await rig();
    dev.speed(3.5);
    tm.setSpeed(3.5);
    await tm.stop();
    dev.speed(0);
    tm.setSpeed(2);
    await tm.start();
    expect(tm.state.target).toBe(2);
  });

  it('stop goes out and the program is told', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    dev.speed(3);
    expect(await tm.stop()).toBe(true);
    expect(dev.writes).toEqual(['08 01']);
    expect(ended).toHaveBeenCalledWith({ reason: 'stop' });
    expect(tm.state.belt).toBe('stopping');
  });

  it('a listener that throws never keeps a Stop from going out', async () => {
    const { tm, dev } = await rig();
    tm.on('ended', () => { throw new Error('display broke'); });
    tm.on('phase', () => { throw new Error('display broke'); });
    const errors = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => {});
    expect(await tm.stop()).toBe(true);
    expect(dev.writes).toEqual(['08 01']);
    errors.mockRestore();
  });

  it('a Stop that never goes through says that the person has to stop the belt', async () => {
    const { tm, dev } = await rig();
    const failed = vi.fn();
    tm.on('stopFailed', failed);
    dev.writeImpl = async () => { throw new Error('GATT busy'); };
    expect(await tm.stop()).toBe(false);
    expect(failed).toHaveBeenLastCalledWith(true);
    expect(tm.state.stopFailed).toBe(true);
  });

  it('a refused Stop on a moving belt says the same (promise 5)', async () => {
    const { tm, dev } = await rig();
    dev.speed(3);
    dev.answer(0x08, 4);
    expect(tm.state.stopFailed).toBe(true);
  });
});

describe('the buttons', () => {
  it('Stop is there whenever the treadmill is connected, whatever the belt does', async () => {
    const { tm, dev } = await rig();
    expect(tm.state.controls.stop).toBe(true);
    dev.speed(4);
    await tm.start();
    tm.setProgramActive(true);
    expect(tm.state.controls).toMatchObject({ start: false, stop: true });
  });

  it('Start is locked while the belt is starting, runs or a program runs', async () => {
    const { tm, dev } = await rig();
    dev.speed(0);
    expect(tm.state.controls.start).toBe(true);
    await tm.start();
    expect(tm.state.controls.start).toBe(false);
    clock = 5000;
    dev.speed(0);
    expect(tm.state.controls.start).toBe(true);
    tm.setProgramActive(true);
    expect(tm.state.controls.start).toBe(false);
  });
});

describe('the treadmill stops by itself (promise 7)', () => {
  it.each([
    [[0x02, 0x01], 'machine-stopped'],
    [[0x02, 0x02], 'machine-paused'],
    [[0x03], 'safety-key'],
  ] as const)('Machine Status %j ends the program and the ramp', async (bytes, reason) => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    dev.speed(2);
    tm.setSpeed(4);
    dev.machineStatus(...bytes);
    expect(ended).toHaveBeenCalledWith({ reason });
    expect(tm.state.target).toBeNull();
  });

  it('a belt that stands still while a program wants a speed ends the program', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    tm.setProgramActive(true);
    dev.speed(2);
    tm.setSpeed(3, { source: 'program' });
    clock = 1000; dev.speed(0);
    clock = 9000; dev.speed(0);
    expect(ended).toHaveBeenCalledWith({ reason: 'standstill' });
    expect(tm.state.target).toBeNull();
  });

  it('in 0.x only a program watches for standstill, a speed set by hand does not', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    tm.setProgramActive(true);
    dev.speed(2);
    tm.setSpeed(3);
    clock = 1000; dev.speed(0);
    clock = 9000; dev.speed(0);
    expect(ended).not.toHaveBeenCalled();
  });

  it('the end of a program ends the watch', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    tm.setProgramActive(true);
    dev.speed(2);
    tm.setSpeed(3, { source: 'program' });
    tm.setProgramActive(false);
    tm.setProgramActive(true);
    clock = 1000; dev.speed(0);
    clock = 9000; dev.speed(0);
    expect(ended).not.toHaveBeenCalled();
  });
});

describe('ended comes once per run of the belt', () => {
  /** A rig whose belt runs at 3 km/h after a start, with every ended reason recorded */
  async function running() {
    const r = await rig();
    const reasons: string[] = [];
    r.tm.on('ended', e => reasons.push(e.reason));
    r.dev.speed(0);
    await r.tm.start();
    r.dev.speed(3);
    return { ...r, reasons };
  }

  it.each([
    ['stop', [0x02, 0x01]],
    ['pause', [0x02, 0x02]],
  ] as const)('%s, then the treadmill reporting it, is one ended', async (how, report) => {
    const { tm, dev, reasons } = await running();
    await (how === 'stop' ? tm.stop() : tm.pause());
    dev.machineStatus(...report);
    expect(reasons).toEqual([how]);
  });

  it('a raw stop, then the treadmill reporting it, is one ended', async () => {
    const { tm, dev, reasons } = await running();
    await tm.sendRaw([0x08, 0x01]);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['console']);
  });

  it('the treadmill stopping by itself still forgets the ramp after the app stopped', async () => {
    const { tm, dev } = await running();
    await tm.stop();
    tm.setSpeed(4);
    dev.machineStatus(0x02, 0x01);
    expect(tm.state.target).toBeNull();
  });

  it('after a new start, the next end is told again', async () => {
    const { tm, dev, reasons } = await running();
    await tm.stop();
    dev.speed(0);
    await tm.start();
    dev.speed(3);
    dev.machineStatus(0x03);
    expect(reasons).toEqual(['stop', 'safety-key']);
  });

  it('a belt started on the treadmill itself is a new run', async () => {
    const { tm, dev, reasons } = await running();
    await tm.stop();
    dev.speed(0);
    dev.machineStatus(0x04);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['stop', 'machine-stopped']);
  });

  it('a belt measured moving again after it stood is a new run, even without a Machine Status', async () => {
    const { tm, dev, reasons } = await running();
    await tm.stop();
    dev.speed(0);
    dev.speed(2.5);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['stop', 'machine-stopped']);
  });

  it('a belt that still slows down after a stop is not a new run', async () => {
    const { tm, dev, reasons } = await running();
    await tm.stop();
    dev.speed(2);
    dev.speed(1);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['stop']);
  });

  it('a program that starts after an end always gets its own end', async () => {
    const { tm, dev, reasons } = await running();
    await tm.stop();
    tm.setProgramActive(true);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['stop', 'machine-stopped']);
  });

  it('a new connection is a new run', async () => {
    const { tm, dev, adapter, reasons } = await running();
    await tm.stop();
    dev.disconnect();
    await tm.connect(adapter);
    dev.speed(3);
    dev.machineStatus(0x02, 0x01);
    expect(reasons).toEqual(['stop', 'machine-stopped']);
  });
});

describe('incline', () => {
  it('is clamped to the range the treadmill reported', async () => {
    const { tm, dev } = await rig();
    expect(await tm.setIncline(15)).toBe(true);
    expect(dev.writes).toEqual(['03 64 00']);
  });

  it('never throws, and an unreadable range uses a safe one (#28 C)', async () => {
    const dev = new FakeTreadmill();
    dev.readable.delete('1826/2ad5');
    const tm = createTreadmill({ clock: { now: () => 0, wait: async () => {} } });
    await tm.connect({ kind: 'fake', availability: async () => ({ ok: true }), requestDevice: async () => dev });
    dev.writes = [];
    await expect(tm.setIncline(Infinity)).resolves.toBe(false);
    await expect(tm.setIncline(5000)).resolves.toBe(false);
    expect(dev.writes).toEqual([]);
    expect(await tm.setIncline(300)).toBe(true);
    expect(await tm.setIncline(-5)).toBe(true);
    expect(dev.writes).toEqual(['03 96 00', '03 00 00']); // 15 % and 0 %, not 300 % or downhill
  });
});

describe('raw commands (experiment console)', () => {
  it('a raw Start is only sent once confirmed', async () => {
    const { tm, dev } = await rig();
    expect(await tm.sendRaw([0x07])).toEqual({ action: 'needs-confirmation' });
    expect(dev.writes).toEqual([]);
    expect(await tm.sendRaw([0x07], { confirmed: true })).toEqual({ action: 'sent', ok: true });
    expect(dev.writes).toEqual(['07']);
    expect(tm.state.maybeRunning).toBe(true);
  });

  it('a raw stop ends the program and the ramp, and goes out at once', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    dev.speed(2);
    tm.setSpeed(3);
    dev.writes = [];
    expect(await tm.sendRaw([0x08, 0x01])).toEqual({ action: 'sent', ok: true });
    expect(ended).toHaveBeenCalledWith({ reason: 'console' });
    expect(tm.state.target).toBeNull();
    expect(dev.writes.at(-1)).toBe('08 01');
  });

  it('a raw Stop during a Start leaves nothing to start the belt after it (#27 B)', async () => {
    const { tm, dev } = await rig();
    let release!: () => void;
    dev.writeImpl = d => (d[0] === 0x00 ? new Promise(r => { release = r; }) : Promise.resolve());
    const starting = tm.start();
    await Promise.resolve();
    const raw = tm.sendRaw([0x08, 0x01]);
    release();
    expect(await starting).toBe(false);
    await raw;
    expect(dev.writes.slice(dev.writes.indexOf('08 01') + 1)).toEqual([]);
  });

  it('a raw Stop that does not get through is sent again and warns, like a Stop (#27 B)', async () => {
    const { tm, dev } = await rig();
    dev.speed(2);
    dev.writeImpl = async () => { throw new Error('GATT busy'); };
    const failed = vi.fn();
    tm.on('stopFailed', failed);
    expect(await tm.sendRaw([0x08, 0x01])).toEqual({ action: 'sent', ok: false });
    expect(failed).toHaveBeenCalledWith(true);
    expect(tm.state.stopFailed).toBe(true);
  });

  it('a Stop that went through but was refused afterwards (80 08 04) still warns when no speed was ever reported (#27 D)', async () => {
    const { tm, dev } = await rig();
    expect(await tm.start()).toBe(true);
    expect(await tm.stop()).toBe(true);
    dev.answer(0x08, 4);
    expect(tm.state.stopFailed).toBe(true);
  });

  it('a Stop refused on a belt that was never started and never reported a speed warns nobody', async () => {
    const { tm, dev } = await rig();
    expect(await tm.stop()).toBe(true);
    dev.answer(0x08, 4);
    expect(tm.state.stopFailed).toBe(false);
  });

  it('a raw Pause is a Pause with the reason console', async () => {
    const { tm, dev } = await rig();
    const ended = vi.fn();
    tm.on('ended', ended);
    expect(await tm.sendRaw([0x08, 0x02])).toEqual({ action: 'sent', ok: true });
    expect(ended).toHaveBeenCalledWith({ reason: 'console' });
    expect(dev.writes.at(-1)).toBe('08 02');
  });

  it('anything that is not a byte is blocked, so the check sees what is sent (#24)', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    const bad = { action: 'blocked', reason: { code: 'console-bad-bytes' } };
    for (const bytes of [[0x102, 0xff, 0xff], [2.5, 0xb0, 0x04], [0x02, -1, 0xff], [0x107], [0x106, 0x64], [NaN], []]) {
      expect(await tm.sendRaw(bytes)).toEqual(bad);
      expect(await tm.sendRaw(bytes, { confirmed: true })).toEqual(bad);
    }
    expect(dev.writes).toEqual([]);
  });

  it('a list that answers differently each time it is read sends what was checked (#24)', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    let reads = 0;
    const shifty = [0x02, 0, 0x00];
    // the first read of the second byte says 0x64 (1.00 km/h, the base of the ramp), every later one 0xff (2.55 km/h, a jump the check blocks)
    Object.defineProperty(shifty, 1, { get: () => (reads++ === 0 ? 0x64 : 0xff) });
    expect(await tm.sendRaw(shifty)).toEqual({ action: 'sent', ok: true });
    expect(dev.writes).toEqual(['02 64 00']);
    expect(reads).toBe(1);
  });

  it('a huge list is blocked and nothing is sent', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    const bad = { action: 'blocked', reason: { code: 'console-bad-bytes' } };
    const huge: number[] = [];
    huge.length = 2 ** 32 - 1; // holes only: copying them would hang the main thread
    expect(await tm.sendRaw(huge)).toEqual(bad);
    expect(await tm.sendRaw(Array.from({ length: 513 }, () => 0))).toEqual(bad);
    expect(dev.writes).toEqual([]);
  });

  it('nothing without a connection', async () => {
    const tm = createTreadmill();
    expect(await tm.sendRaw([0x00])).toEqual({ action: 'not-connected' });
  });
});

describe('nothing is set while the belt coasts down after a stop (#25)', () => {
  const flush = () => new Promise(r => setTimeout(r, 5));
  const setSpeeds = (dev: FakeTreadmill) => dev.writes.filter(w => w.startsWith('02'));

  async function coasting(how: 'stop' | 'pause' | 'machine-stopped' | 'safety-key' | 'raw-stop') {
    const r = await rig();
    r.dev.speed(4);
    r.tm.setSpeed(4);
    clock += 10_000;
    await flush();
    if (how === 'stop') await r.tm.stop();
    else if (how === 'pause') await r.tm.pause();
    else if (how === 'raw-stop') await r.tm.sendRaw([0x08, 0x01]);
    else if (how === 'machine-stopped') r.dev.machineStatus(0x02, 0x01);
    else r.dev.machineStatus(0x03);
    r.dev.writes = [];
    return r;
  }

  it.each(['stop', 'pause', 'machine-stopped', 'safety-key', 'raw-stop'] as const)(
    'after %s, a speed asked for while the belt decelerates is held, not written', async how => {
      const { tm, dev } = await coasting(how);
      for (const kmh of [3.5, 2.5, 1.5, 0.6]) { dev.speed(kmh); tm.setSpeed(5); clock += 2000; }
      clock += 5000;
      dev.speed(0.2);
      await flush();
      expect(setSpeeds(dev)).toEqual([]);
      expect(tm.state.target).toBe(5);
    });

  it('a speed held through the coast-down goes out only after Start and a moving belt', async () => {
    const { tm, dev } = await coasting('stop');
    dev.speed(3.5);
    tm.setSpeed(5);
    dev.speed(0);
    clock += 5000;
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    await tm.start();
    expect(setSpeeds(dev)).toEqual(['02 64 00']); // only the start speed
    dev.writes = [];
    clock += 2000;
    dev.speed(1);
    await flush();
    expect(setSpeeds(dev)).toEqual(['02 96 00']); // the first ramp step: 1.0 + maxStep 0.5 (promise 2)
  });

  it('a start that fails during the coast-down does not end the wait: 3.5, 0, start fails, 2.5, 2, 1.5', async () => {
    const { tm, dev, notices } = await coasting('stop');
    dev.speed(3.5);
    tm.setSpeed(5);
    dev.speed(0); // one spurious 0.0 (#49): Start is not refused as on a moving belt
    dev.writeImpl = async d => { if (d[0] === 0x02) throw new Error('GATT busy'); };
    expect(await tm.start()).toBe(false);
    expect(notices).toContainEqual({ code: 'start-speed-failed' });
    dev.writeImpl = async () => {};
    dev.writes = [];
    tm.setSpeed(5); // asked for again after the failed start
    for (const kmh of [2.5, 2, 1.5]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a raw Start whose write fails during the coast-down does not end the wait: 3.5, raw Start fails, 2.5, 2, 1.5', async () => {
    const { tm, dev } = await coasting('stop');
    dev.speed(3.5);
    dev.writeImpl = async d => { if (d[0] === 0x07) throw new Error('GATT busy'); };
    expect(await tm.sendRaw([0x07], { confirmed: true })).toEqual({ action: 'sent', ok: false });
    dev.writeImpl = async () => {};
    dev.writes = [];
    tm.setSpeed(5);
    for (const kmh of [2.5, 2, 1.5]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a raw Start that went out during the coast-down is a new run: the held speed is ramped once the belt moves', async () => {
    const { tm, dev } = await coasting('stop');
    dev.speed(3.5);
    tm.setSpeed(5);
    expect(await tm.sendRaw([0x07], { confirmed: true })).toEqual({ action: 'sent', ok: true });
    tm.setSpeed(5);
    clock += 2000;
    dev.speed(1);
    await flush();
    expect(setSpeeds(dev)).not.toEqual([]);
  });

  it('a Stop that comes in while a raw Start is on its way keeps the wait: Start 07 held, 08 01, write released, 3.5, 2.5, 1.5', async () => {
    const { tm, dev } = await coasting('stop');
    let release!: () => void;
    dev.writeImpl = d => (d[0] === 0x07 ? new Promise(r => { release = r; }) : Promise.resolve());
    const raw = tm.sendRaw([0x07], { confirmed: true });
    await flush();
    const stopped = tm.sendRaw([0x08, 0x01]);
    tm.setSpeed(5);
    release();
    await raw;
    await stopped;
    dev.writes = [];
    for (const kmh of [3.5, 2.5, 1.5]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it.each([[[0x03]], [[0x02, 0x01]], [[0x02, 0x02]]])(
    'a stop the treadmill reports (%j) while a raw Start is on its way keeps the wait: 3.5, 2.5, 1.5 send nothing', async report => {
      const { tm, dev } = await coasting('stop');
      let release!: () => void;
      dev.writeImpl = d => (d[0] === 0x07 ? new Promise(r => { release = r; }) : Promise.resolve());
      const raw = tm.sendRaw([0x07], { confirmed: true });
      await flush();
      dev.machineStatus(...report);
      tm.setSpeed(5);
      release();
      await raw;
      dev.writes = [];
      for (const kmh of [3.5, 2.5, 1.5]) { clock += 2000; dev.speed(kmh); }
      await flush();
      expect(setSpeeds(dev)).toEqual([]);
      expect(tm.state.target).toBe(5);
    });

  it.each([[[0x03]], [[0x02, 0x01]], [[0x02, 0x02]]])(
    'a stop the treadmill reports (%j) while start() sends Start keeps the wait: 3.5, 2.5, 1.5 send nothing', async report => {
      const { tm, dev } = await coasting('stop');
      dev.speed(0);
      tm.setSpeed(5);
      let release: (() => void) | undefined;
      dev.writeImpl = d => (d[0] === 0x07 ? new Promise(r => { release = r; }) : Promise.resolve());
      const started = tm.start();
      for (let i = 0; i < 50; i++) {
        if (release) break;
        await flush();
      }
      expect(release).toBeDefined();
      dev.machineStatus(...report);
      release!();
      expect(await started).toBe(false);
      dev.writes = [];
      tm.setSpeed(5); // asked for again after the overtaken start
      for (const kmh of [3.5, 2.5, 1.5]) { clock += 2000; dev.speed(kmh); }
      await flush();
      expect(setSpeeds(dev)).toEqual([]);
      expect(tm.state.target).toBe(5);
    });

  it('a raw Start without a Stop in between still ends the wait', async () => {
    const { tm, dev } = await coasting('stop');
    let release!: () => void;
    dev.writeImpl = d => (d[0] === 0x07 ? new Promise(r => { release = r; }) : Promise.resolve());
    const raw = tm.sendRaw([0x07], { confirmed: true });
    await flush();
    tm.setSpeed(5);
    release();
    await raw;
    clock += 2000;
    dev.speed(1);
    await flush();
    expect(setSpeeds(dev)).not.toEqual([]);
  });

  it('a belt restarted on the console without a reading below 0.1 and without started: once it runs steady a lowered limit is sent', async () => {
    const { tm, dev } = await coasting('stop');
    tm.setLimits({ speedLimit: 6 });
    dev.speed(0); // one 0.0, then the treadmill is quiet and is restarted on its own console without a "started"
    clock += 10_000;
    for (const kmh of [4, 4, 4]) { dev.speed(kmh); clock += 1500; }
    dev.writes = [];
    tm.setLimits({ speedLimit: 3 });
    for (const kmh of [4, 4]) { dev.speed(kmh); clock += 1500; }
    await flush();
    expect(setSpeeds(dev)).toEqual(['02 2c 01']); // 3.0 in one command, as before the hold existed (promise 2)
  });

  it('a belt that only coasts down (3.5, 3.0, 2.5, 2.0) never counts as steady: nothing is sent', async () => {
    const { tm, dev } = await coasting('stop');
    tm.setSpeed(5);
    for (const kmh of [3.5, 3, 2.5, 2]) { dev.speed(kmh); clock += 1000; }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a late Machine Status started while the belt still coasts down does not end the wait', async () => {
    const { tm, dev } = await coasting('stop');
    dev.speed(3.5);
    tm.setSpeed(5);
    dev.machineStatus(0x04); // a Start answered late, or sent by mistake: the belt still decelerates
    for (const kmh of [2.5, 1.5, 0.6]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a late started after one spurious 0.0 during the coast-down does not end the wait (#49)', async () => {
    const { tm, dev } = await coasting('stop');
    tm.setSpeed(5);
    for (const kmh of [3.5, 0, 2.5]) { dev.speed(kmh); clock += 600; }
    dev.machineStatus(0x04);
    for (const kmh of [2, 1.5]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a started right after one spurious 0.0 does not end the wait: 3.5, 0, started, 2.5, 2, 1.5 (#49)', async () => {
    const { tm, dev } = await coasting('stop');
    tm.setSpeed(5);
    for (const kmh of [3.5, 0]) { dev.speed(kmh); clock += 300; }
    dev.machineStatus(0x04);
    for (const kmh of [2.5, 2, 1.5]) { clock += 2000; dev.speed(kmh); }
    await flush();
    expect(setSpeeds(dev)).toEqual([]);
    expect(tm.state.target).toBe(5);
  });

  it('a belt that stands (two readings below 0.1, 1 s apart) and is started on the treadmill is a new run: the held speed is ramped', async () => {
    const { tm, dev } = await coasting('stop');
    dev.speed(3.5);
    tm.setSpeed(5);
    dev.speed(0);
    clock += 1000;
    dev.speed(0); // standing confirmed
    dev.machineStatus(0x04);
    clock += 2000;
    dev.speed(1);
    clock += 2000;
    dev.speed(1);
    await flush();
    expect(setSpeeds(dev)).toEqual(['02 96 00']); // the first ramp step: 1.0 + maxStep 0.5 (promise 2)
  });
});
