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
  private readonly readable = new Map<string, number[]>([
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

describe('the speed limit (promise 1)', () => {
  it('never commands above the limit', async () => {
    const { tm, dev } = await rig({ speedLimit: 4 });
    dev.speed(3.8);
    expect(tm.setSpeed(7)).toBe(4);
    expect(dev.writes.every(w => !w.startsWith('02') || w === '02 90 01')).toBe(true);
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

  it('lowering never needs it, and nonsense is the default limit', async () => {
    const { tm } = await rig();
    tm.setLimits({ speedLimit: 4 });
    expect(tm.state.speedLimit).toBe(4);
    tm.setLimits({ speedLimit: Number.NaN });
    expect(tm.state.speedLimit).toBe(DEFAULT_SPEED_LIMIT);
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

describe('incline', () => {
  it('is clamped to the range the treadmill reported', async () => {
    const { tm, dev } = await rig();
    expect(await tm.setIncline(15)).toBe(true);
    expect(dev.writes).toEqual(['03 64 00']);
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

  it('nothing without a connection', async () => {
    const tm = createTreadmill();
    expect(await tm.sendRaw([0x00])).toEqual({ action: 'not-connected' });
  });
});
