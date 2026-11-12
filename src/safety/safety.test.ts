import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beltMaybeRunning, checkConsoleCommand, controlAvailability, clampSpeed, DEFAULT_MAX_STEP, DEFAULT_SPEED_LIMIT,
  parseHexBytes, planRamp, RAMP_INTERVAL_MS, SpeedGovernor, StandstillDetector, type ConsoleContext,
} from './safety.ts';
import type { Notice } from '../protocol/notice.ts';

describe('defaults', () => {
  it('default limit is 6 km/h, step 0.5 km/h', () => {
    expect(DEFAULT_SPEED_LIMIT).toBe(6);
    expect(DEFAULT_MAX_STEP).toBe(0.5);
  });
});

describe('clampSpeed', () => {
  const range = { min: 1, max: 6 };

  it('clamps at the top and bottom', () => {
    expect(clampSpeed(9, range)).toBe(6);
    expect(clampSpeed(0.2, range)).toBe(1);
  });

  it('rounds to 0.1 km/h', () => {
    expect(clampSpeed(3.04, range)).toBe(3);
    expect(clampSpeed(3.06, range)).toBe(3.1);
  });

  it('rounding never goes above the maximum', () => {
    expect(clampSpeed(9, { min: 1, max: 5.97 })).toBe(5.9);
  });

  it('never returns a value above the maximum, even if the limit is below the device minimum', () => {
    expect(clampSpeed(3, { min: 1.5, max: 1 })).toBeNull();
  });

  it('NaN and infinity → null', () => {
    expect(clampSpeed(Number.NaN, range)).toBeNull();
    expect(clampSpeed(Number.POSITIVE_INFINITY, range)).toBeNull();
  });
});

describe('planRamp', () => {
  const range = { min: 1, max: 6 };

  it('approaches large jumps in steps', () => {
    expect(planRamp(2, 5, 0.5, range)).toEqual([2.5, 3, 3.5, 4, 4.5, 5]);
    expect(planRamp(5, 2, 0.5, range)).toEqual([4.5, 4, 3.5, 3, 2.5, 2]);
  });

  it('small changes in one step', () => {
    expect(planRamp(2, 2.3, 0.5, range)).toEqual([2.3]);
    expect(planRamp(2, 2.5, 0.5, range)).toEqual([2.5]);
  });

  it('no step if already at the target', () => {
    expect(planRamp(3, 3, 0.5, range)).toEqual([]);
  });

  it('clamps the target to the range', () => {
    expect(planRamp(5, 9, 0.5, range)).toEqual([5.5, 6]);
  });

  it('from standstill: the first step is the device minimum', () => {
    expect(planRamp(0, 2, 0.5, range)).toEqual([1, 1.5, 2]);
  });

  it('odd start value: no step larger than maxStep', () => {
    expect(planRamp(2.05, 3, 0.3, range)).toEqual([2.3, 2.6, 2.9, 3]);
  });

  it('small steps despite floating point errors', () => {
    expect(planRamp(0.7, 1, 0.1, { min: 0.5, max: 6 })).toEqual([0.8, 0.9, 1]);
  });

  it('never a command above the limit, not even when slowing down from above', () => {
    expect(planRamp(6, 4, 0.5, { min: 1, max: 4 })).toEqual([4]);
  });

  it('no allowed value → no steps', () => {
    expect(planRamp(2, 3, 0.5, { min: 2, max: 1 })).toEqual([]);
  });

  it('invariants for random inputs', () => {
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
      const r = { min: 0.5 + rnd(), max: 3 + rnd() * 10 };
      const step = Math.round((0.1 + rnd() * 0.9) * 10) / 10;
      const from = rnd() * 14;
      const to = rnd() * 14;
      const plan = planRamp(from, to, step, r);
      const target = clampSpeed(to, r)!;
      if (plan.length) expect(plan.at(-1)).toBeCloseTo(target, 9);
      let prev = from;
      plan.forEach((v, k) => {
        expect(v).toBeLessThanOrEqual(r.max + 1e-9);
        expect(v).toBeGreaterThanOrEqual(r.min - 1e-9);
        const firstFromOutside = k === 0 && (from < r.min || from > r.max);
        if (!firstFromOutside) expect(Math.abs(v - prev)).toBeLessThanOrEqual(step + 1e-9);
        prev = v;
      });
    }
  });
});

describe('SpeedGovernor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  function make(opts: { fail?: (kmh: number) => boolean } = {}) {
    const sent: [number, number][] = [];
    const logs: Notice[] = [];
    const gov = new SpeedGovernor({
      send: async kmh => { sent.push([Date.now(), kmh]); return !opts.fail?.(kmh); },
      now: () => Date.now(),
      notice: n => logs.push(n),
    });
    gov.setRange({ min: 1, max: 6 });
    return { gov, sent, logs };
  }

  it('minimum interval is 1.5 s', () => {
    expect(RAMP_INTERVAL_MS).toBe(1500);
  });

  it('a small change goes out immediately', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    expect(gov.request(2.5)).toBe(2.5);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([[0, 2.5]]);
  });

  it('a large jump is approached in steps 1.5 s apart', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([[0, 2.5], [1500, 3], [3000, 3.5], [4500, 4]]);
    expect(gov.ramping).toBe(false);
  });

  it('fast +0.5 clicks do not turn into a jump', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(2.5);
    await vi.advanceTimersByTimeAsync(100);
    gov.request(3);
    await vi.advanceTimersByTimeAsync(100);
    gov.request(3.5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([[0, 2.5], [1500, 3], [3000, 3.5]]);
  });

  it('never two commands closer than 1.5 s, even across separate requests', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(3);
    gov.request(3.5);
    await vi.advanceTimersByTimeAsync(1000);
    gov.request(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([[0, 3.5], [1500, 3]]);
  });

  it('caps targets to the limit', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(5.5);
    expect(gov.request(9)).toBe(6);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([[0, 6]]);
  });

  it('no allowed value → null, nothing sent', async () => {
    const { gov, sent, logs } = make();
    gov.setRange({ min: 2, max: 1 });
    expect(gov.request(3)).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
    expect(logs).toEqual([{ code: 'no-allowed-speed', min: 2, max: 1 }]);
  });

  it('cancel stops the ramp immediately', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(2000);
    gov.cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([[0, 2.5], [1500, 3]]);
    expect(gov.target).toBeNull();
    expect(gov.ramping).toBe(false);
  });

  it('a write error aborts the ramp', async () => {
    const { gov, sent, logs } = make({ fail: kmh => kmh === 3 });
    gov.noteMeasured(2);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toEqual([[0, 2.5], [1500, 3]]);
    expect(gov.target).toBeNull();
    expect(logs).toEqual([{ code: 'ramp-aborted' }]);
  });

  it('a command that was not written is not what the next ramp starts from', async () => {
    const { gov, sent } = make({ fail: kmh => kmh === 3 && sent.length === 2 });
    gov.noteMeasured(2);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gov.lastCommand?.kmh).toBe(2.5);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(0);
    // On from 2.5, the last speed the belt got: not from the 3 it never got (which would make this step 3.5)
    expect(sent.at(-1)?.[1]).toBe(3);
  });

  it('a speed the treadmill refused ends the ramp, and the command is forgotten', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.map(s => s[1])).toEqual([2.5]);
    gov.commandRefused();
    expect(gov.target).toBeNull();
    expect(gov.lastCommand).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([2.5]);
    // The next ramp starts from what the belt does
    gov.noteMeasured(2);
    expect(gov.base()).toBe(2);
  });

  it('from standstill, the ramp starts at the device minimum once the belt moves', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(0);
    gov.request(2);
    gov.noteMeasured(0.3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([1, 1.5, 2]);
  });

  it('without a measured value and without a last command: the base is the device minimum', async () => {
    const { gov, sent } = make();
    gov.request(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([1.5, 2]);
  });

  it('the base is the last command while the belt is still settling', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(2.5);
    await vi.advanceTimersByTimeAsync(2000);
    gov.noteMeasured(2.1); // the belt has not reached 2.5 yet
    gov.request(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.map(s => s[1])).toEqual([2.5, 3]);
  });

  it('the base is the measured value if the belt runs clearly differently (e.g. changed with the remote)', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(2.5);
    await vi.advanceTimersByTimeAsync(10_000);
    gov.noteMeasured(4); // someone set 4 on the treadmill
    gov.request(5);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([2.5, 4.5, 5]);
  });

  it('lowering the limit below the last command actively regulates to the new limit', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(5);
    gov.request(5);
    await vi.advanceTimersByTimeAsync(10_000);
    gov.setRange({ min: 1, max: 4 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([5, 4]);
    expect(gov.target).toBe(4);
  });

  it('lowering the limit during a ramp caps the target', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(2);
    gov.request(6);
    await vi.advanceTimersByTimeAsync(1600);
    gov.setRange({ min: 1, max: 3.5 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.map(s => s[1])).toEqual([2.5, 3, 3.5]);
  });

  it('reset forgets the last command (after stop/disconnect)', async () => {
    const { gov, sent } = make();
    gov.noteMeasured(3);
    gov.request(3.5);
    await vi.advanceTimersByTimeAsync(100);
    gov.reset();
    expect(gov.lastCommand).toBeNull();
    gov.request(2);
    gov.noteMeasured(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // after reset: no minimum interval reference any more, the next step goes out at once from the measured speed
    expect(sent).toEqual([[0, 3.5], [100, 1.5], [1600, 2]]);
  });

  it('an external command (console) counts as base and for the minimum interval', async () => {
    const { gov, sent } = make();
    gov.noteExternalCommand(3);
    expect(gov.msSinceLastCommand()).toBe(0);
    gov.request(3.5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([[1500, 3.5]]);
  });

  it('maxStep is configurable', async () => {
    const { gov, sent } = make();
    gov.maxStep = 1;
    gov.noteMeasured(2);
    gov.request(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.map(s => s[1])).toEqual([3, 4]);
  });

  describe('a speed chosen while the belt stands', () => {
    it('is held, not sent: a treadmill would remember it and run up to it by itself after Start', async () => {
      const { gov, sent } = make();
      gov.noteMeasured(0);
      expect(gov.request(5)).toBe(5);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual([]);
      expect(gov.target).toBe(5);
      expect(gov.holding).toBe(true);
    });

    it('counts as standing after reset (stop, start, new connection) until the belt is seen moving', async () => {
      const { gov, sent } = make();
      gov.noteMeasured(3);
      gov.reset();
      gov.request(4);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual([]);
      expect(gov.holding).toBe(true);
    });

    it('is approached in steps from the starting speed once the belt moves', async () => {
      const { gov, sent } = make();
      gov.reset();
      await gov.startSpeed();
      gov.request(3);
      gov.noteMeasured(0);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sent.map(s => s[1])).toEqual([1]);
      gov.noteMeasured(1);
      expect(gov.holding).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.map(s => s[1])).toEqual([1, 1.5, 2, 2.5, 3]);
      for (let i = 1; i < sent.length - 1; i++) expect(sent[i + 1]![0] - sent[i]![0]).toBeGreaterThanOrEqual(RAMP_INTERVAL_MS);
    });

    it('a movement below 0.3 km/h is not moving yet', async () => {
      const { gov, sent } = make();
      gov.reset();
      gov.request(3);
      gov.noteMeasured(0.2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual([]);
    });

    it('is clamped to the limit like any request, also when the limit is lowered while it is held', async () => {
      const { gov, sent } = make();
      gov.reset();
      expect(gov.request(9)).toBe(6);
      gov.setRange({ min: 1, max: 4 });
      expect(gov.target).toBe(4);
      gov.noteMeasured(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(Math.max(...sent.map(s => s[1]))).toBe(4);
    });

    it('is forgotten by reset (a stop) and never sent', async () => {
      const { gov, sent } = make();
      gov.reset();
      gov.request(4);
      gov.reset();
      expect(gov.target).toBeNull();
      gov.noteMeasured(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual([]);
    });

    it('a belt that comes to a stand holds the next request again', async () => {
      const { gov, sent } = make();
      gov.noteMeasured(2);
      gov.noteMeasured(0);
      gov.request(2.5);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual([]);
    });

    it('says once in the log that it is held, not again for the same speed', () => {
      const { gov, logs } = make();
      gov.reset();
      gov.request(4);
      gov.request(4);
      expect(logs).toHaveLength(1);
      gov.request(4.5);
      expect(logs).toHaveLength(2);
    });
  });

  describe('startSpeed: the speed the belt starts at', () => {
    it('sets the lowest speed the device allows, once, and says it worked', async () => {
      const { gov, sent } = make();
      expect(await gov.startSpeed()).toBe(true);
      expect(sent).toEqual([[0, 1]]);
      expect(gov.lastCommand).toEqual({ kmh: 1, at: 0 });
    });

    it('uses the device minimum, not a fixed value', async () => {
      const { gov, sent } = make();
      gov.setRange({ min: 0.5, max: 6 });
      await gov.startSpeed();
      expect(sent.map(s => s[1])).toEqual([0.5]);
    });

    it('ends a ramp that was running and forgets its target', async () => {
      const { gov, sent } = make();
      gov.noteMeasured(2);
      gov.request(5);
      await vi.advanceTimersByTimeAsync(0);
      expect(gov.target).toBe(5);
      await gov.startSpeed();
      expect(gov.target).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.map(s => s[1])).toEqual([2.5, 1]);
    });

    it('lets the next ramp start from there, no sooner than 1.5 s later', async () => {
      const { gov, sent } = make();
      await gov.startSpeed();
      gov.request(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual([[0, 1], [1500, 1.5], [3000, 2]]);
    });

    it('says no, and remembers nothing, if the device does not take it', async () => {
      const { gov } = make({ fail: () => true });
      expect(await gov.startSpeed()).toBe(false);
      expect(gov.lastCommand).toBeNull();
    });

    it('says no if sending throws', async () => {
      const gov = new SpeedGovernor({ send: async () => { throw new Error('x'); }, now: () => 0 });
      expect(await gov.startSpeed()).toBe(false);
      expect(gov.lastCommand).toBeNull();
    });

    it('sends nothing if the limit is below the lowest speed of the device', async () => {
      const { gov, sent, logs } = make();
      gov.setRange({ min: 1, max: 0.8 });
      expect(await gov.startSpeed()).toBe(false);
      expect(sent).toEqual([]);
      expect(logs).toHaveLength(1);
    });
  });
});

describe('experiment console', () => {
  const ctx: ConsoleContext = { maxKmh: 6, maxStep: 0.5, baseKmh: 3, msSinceLastSpeedCommand: 10_000 };
  const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

  it('parses hex bytes with spaces or commas', () => {
    expect(parseHexBytes('02 2C 01')).toEqual([0x02, 0x2c, 0x01]);
    expect(parseHexBytes(' 08,01 ')).toEqual([0x08, 0x01]);
  });

  it('rejects anything that is not a clean hex byte', () => {
    expect(parseHexBytes('')).toBeNull();
    expect(parseHexBytes('zz')).toBeNull();
    expect(parseHexBytes('100')).toBeNull();
    expect(parseHexBytes('2z')).toBeNull(); // parseInt would return 2 here
  });

  it('blocks Set Speed above the limit', () => {
    const c = { ...ctx, baseKmh: 5.8 };
    expect(checkConsoleCommand([0x02, ...le16(600)], c)).toEqual({ action: 'send', setSpeed: 6 });
    expect(checkConsoleCommand([0x02, ...le16(601)], c).action).toBe('block');
  });

  it('blocks Set Speed with the wrong length', () => {
    expect(checkConsoleCommand([0x02, 0x2c], ctx).action).toBe('block');
    expect(checkConsoleCommand([0x02, 0x2c, 0x01, 0x00], ctx).action).toBe('block');
  });

  it('blocks Set Speed jumps above the maximum change', () => {
    expect(checkConsoleCommand([0x02, ...le16(350)], ctx).action).toBe('send');
    expect(checkConsoleCommand([0x02, ...le16(360)], ctx).action).toBe('block');
    expect(checkConsoleCommand([0x02, ...le16(240)], ctx).action).toBe('block');
  });

  it('blocks Set Speed within the minimum interval', () => {
    expect(checkConsoleCommand([0x02, ...le16(320)], { ...ctx, msSinceLastSpeedCommand: 1000 }).action).toBe('block');
  });

  it('start only with confirmation', () => {
    expect(checkConsoleCommand([0x07], ctx)).toEqual({ action: 'confirm-start' });
  });

  it('blocks Set Target Heart Rate (the treadmill would control the speed itself)', () => {
    expect(checkConsoleCommand([0x06, 120], ctx).action).toBe('block');
  });

  it('lets other commands through raw', () => {
    expect(checkConsoleCommand([0x08, 0x01], ctx)).toEqual({ action: 'send' });
    expect(checkConsoleCommand([0x03, 0x32, 0x00], ctx)).toEqual({ action: 'send' });
    expect(checkConsoleCommand([0x00], ctx)).toEqual({ action: 'send' });
  });

  it('names the reason of a block as a code with its values', () => {
    expect(checkConsoleCommand([0x02, ...le16(601)], { ...ctx, baseKmh: 5.8 })).toEqual({ action: 'block', reason: { code: 'console-over-limit', kmh: 6.01, max: 6 } });
    expect(checkConsoleCommand([0x02, 0x2c], ctx)).toEqual({ action: 'block', reason: { code: 'console-set-speed-length' } });
    expect(checkConsoleCommand([0x06, 120], ctx)).toEqual({ action: 'block', reason: { code: 'console-heart-rate' } });
  });
});

describe('belt may be running', () => {
  it('after a start by the app', () => {
    expect(beltMaybeRunning({ startedByApp: true, lastMeasuredKmh: undefined })).toBe(true);
  });

  it('if the last measured value was > 0, no matter how old', () => {
    expect(beltMaybeRunning({ startedByApp: false, lastMeasuredKmh: 1.2 })).toBe(true);
  });

  it('only if both say otherwise: no', () => {
    expect(beltMaybeRunning({ startedByApp: false, lastMeasuredKmh: 0 })).toBe(false);
    expect(beltMaybeRunning({ startedByApp: false, lastMeasuredKmh: undefined })).toBe(false);
  });
});

describe('StandstillDetector', () => {
  it('reports standstill after 8 s at 0 km/h once armed', () => {
    const d = new StandstillDetector();
    d.arm();
    expect(d.feed(0, 0)).toBe(false);
    expect(d.feed(0, 7999)).toBe(false);
    expect(d.feed(0, 8000)).toBe(true);
    expect(d.feed(0, 9000)).toBe(false); // only once
  });

  it('movement resets the counter', () => {
    const d = new StandstillDetector();
    d.arm();
    d.feed(0, 0);
    d.feed(1, 5000);
    expect(d.feed(0, 9000)).toBe(false);
    expect(d.feed(0, 17_000)).toBe(true);
  });

  it('calling arm() again (next program step) does not reset the counter', () => {
    const d = new StandstillDetector();
    d.arm();
    d.feed(0, 0);
    d.arm();
    expect(d.feed(0, 8000)).toBe(true);
  });

  it('not armed → never', () => {
    const d = new StandstillDetector();
    expect(d.feed(0, 0)).toBe(false);
    expect(d.feed(0, 60_000)).toBe(false);
  });
});

describe('controlAvailability: which of Start, Pause and Stop can be pressed', () => {
  const idle = { connected: true, measuredKmh: 0, measuredAgeMs: 500, startedByApp: false, startingNow: false, programActive: false };

  it('Stop can always be pressed while there is a connection, whatever else is going on', () => {
    for (const measuredKmh of [undefined, 0, 0.2, 3, 12]) {
      for (const measuredAgeMs of [0, 4000, 60_000]) {
        for (const startedByApp of [false, true]) {
          for (const startingNow of [false, true]) {
            for (const programActive of [false, true]) {
              const a = controlAvailability({ connected: true, measuredKmh, measuredAgeMs, startedByApp, startingNow, programActive });
              expect(a.stop, JSON.stringify({ measuredKmh, measuredAgeMs, startedByApp, startingNow, programActive })).toBe(true);
            }
          }
        }
      }
    }
  });

  it('nothing can be pressed without a connection', () => {
    expect(controlAvailability({ ...idle, connected: false, measuredKmh: 3, programActive: true })).toEqual({ start: false, pause: false, stop: false });
  });

  it('with the belt standing: Start, no Pause (nothing to pause)', () => {
    expect(controlAvailability(idle)).toEqual({ start: true, pause: false, stop: true });
    expect(controlAvailability({ ...idle, measuredKmh: undefined })).toEqual({ start: true, pause: false, stop: true });
  });

  it('with the belt running: Pause, no Start', () => {
    expect(controlAvailability({ ...idle, measuredKmh: 3 })).toEqual({ start: false, pause: true, stop: true });
  });

  it('a belt that creeps below 0.3 km/h is not "running" for Start, but Pause stays: when in doubt it is running', () => {
    expect(controlAvailability({ ...idle, measuredKmh: 0.2 })).toEqual({ start: true, pause: true, stop: true });
  });

  it('an old reading does not lock Start: after 5 s without news the speed does not count as known', () => {
    expect(controlAvailability({ ...idle, measuredKmh: 3, measuredAgeMs: 5000 }).start).toBe(false);
    expect(controlAvailability({ ...idle, measuredKmh: 3, measuredAgeMs: 5001 }).start).toBe(true);
    expect(controlAvailability({ ...idle, measuredKmh: 3, measuredAgeMs: 60_000 }).pause).toBe(true);
  });

  it('a start that was sent but where the belt has not moved yet: Pause, no second Start', () => {
    expect(controlAvailability({ ...idle, startingNow: true })).toEqual({ start: false, pause: true, stop: true });
  });

  it('a running program: Pause, no Start', () => {
    expect(controlAvailability({ ...idle, programActive: true })).toEqual({ start: false, pause: true, stop: true });
  });

  it('a start by the app without any reading yet counts as "maybe running" for Pause, not as running for Start', () => {
    expect(controlAvailability({ ...idle, measuredKmh: undefined, startedByApp: true })).toEqual({ start: true, pause: true, stop: true });
  });
});
