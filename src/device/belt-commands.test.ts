import { describe, expect, it, vi } from 'vitest';
import type { TreadmillClient } from './ble.ts';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import { hex } from '../protocol/ftms.ts';
import { setupBelt, STOP_ATTEMPTS, type BeltHost } from './belt-commands.ts';
import { BeltState } from './belt-state.ts';

/** Everything the belt touches, in the order it happens */
function rig(opts: { ok?: boolean | ((hexBytes: string) => boolean | Promise<boolean>); client?: boolean; startSpeedOk?: boolean; target?: number; wanted?: number } = {}) {
  const calls: string[] = [];
  const session = new BeltState();
  if (opts.client !== false) {
    session.client = {
      connected: true,
      send: vi.fn(async (bytes: Uint8Array, o?: { urgent?: boolean }) => {
        const h = hex(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        calls.push(`send ${h}${o?.urgent ? ' urgent' : ''}`);
        return typeof opts.ok === 'function' ? opts.ok(h) : (opts.ok ?? true);
      }),
    } as unknown as TreadmillClient;
  }
  const banner = {
    stopRequested: vi.fn(() => calls.push('banner stop')),
    startRequested: vi.fn(() => calls.push('banner start')),
  } satisfies BeltHost['phase'];
  const governor = {
    target: opts.target ?? null,
    request: vi.fn((kmh: number) => { calls.push(`governor request ${kmh}`); return kmh; }),
    reset: vi.fn(() => calls.push('governor reset')),
    startSpeed: vi.fn(async () => { calls.push('governor startSpeed'); return opts.startSpeedOk ?? true; }),
  } as unknown as SpeedGovernor;
  const standstill = { disarm: vi.fn(() => calls.push('standstill disarm')) } as unknown as StandstillDetector;
  const abortRun = vi.fn((_reason: 'stop' | 'pause') => calls.push('abort run'));
  const log = vi.fn(() => calls.push('notice'));
  const wait = vi.fn(async (_ms: number) => {});
  const stopFailed = vi.fn((_failed: boolean) => {});
  const belt = setupBelt({ session, phase: banner, governor, standstill, now: () => 1234, wanted: () => opts.wanted ?? null, ended: abortRun, notice: log, wait, stopFailed });
  const sends = () => calls.filter(c => c.startsWith('send'));
  return { belt, session, calls, sends, banner, abortRun, governor, log, wait, stopFailed };
}

describe('stop', () => {
  it('ends the program, forgets the ramp and then sends Stop urgently', async () => {
    const r = rig();
    r.session.beltStarted = true;
    expect(await r.belt.stop()).toBe(true);
    expect(r.calls).toEqual(['banner stop', 'abort run', 'governor reset', 'standstill disarm', 'send 08 01 urgent']);
    expect(r.session.beltStarted).toBe(false);
  });

  it('tells why the belt ends: stop or pause', async () => {
    const r = rig();
    await r.belt.stop();
    expect(r.abortRun).toHaveBeenLastCalledWith('stop');
    await r.belt.pause();
    expect(r.abortRun).toHaveBeenLastCalledWith('pause');
  });

  it('does all of that even without a connection, and says it could not send', async () => {
    const r = rig({ client: false });
    expect(await r.belt.stop()).toBe(false);
    expect(r.calls).toEqual(['banner stop', 'abort run', 'governor reset', 'standstill disarm']);
  });

  it('keeps "started" if the treadmill did not take the command', async () => {
    const r = rig({ ok: false });
    r.session.beltStarted = true;
    expect(await r.belt.stop()).toBe(false);
    expect(r.session.beltStarted).toBe(true);
  });

  it('a Stop that fails is sent again, with a short wait in between, and then says that it could not stop', async () => {
    const r = rig({ ok: false });
    expect(await r.belt.stop()).toBe(false);
    expect(r.sends()).toEqual(Array(STOP_ATTEMPTS).fill('send 08 01 urgent'));
    expect(r.wait).toHaveBeenCalledTimes(STOP_ATTEMPTS - 1);
    expect(r.stopFailed).toHaveBeenLastCalledWith(true);
  });

  it('a Stop that goes through at the second attempt is a Stop, and takes an earlier warning away', async () => {
    let n = 0;
    const r = rig({ ok: () => ++n > 1 });
    r.session.beltStarted = true;
    expect(await r.belt.stop()).toBe(true);
    expect(r.sends()).toEqual(['send 08 01 urgent', 'send 08 01 urgent']);
    expect(r.session.beltStarted).toBe(false);
    expect(r.stopFailed).toHaveBeenLastCalledWith(false);
    expect(r.stopFailed).not.toHaveBeenCalledWith(true);
  });

  it('does not try again once the connection is gone (the connection alarm says so), and does not warn twice', async () => {
    const r = rig({ ok: false });
    (r.session.client as unknown as { connected: boolean }).connected = false;
    expect(await r.belt.stop()).toBe(false);
    expect(r.sends()).toEqual(['send 08 01 urgent']);
    expect(r.stopFailed).not.toHaveBeenCalledWith(true);
  });

  it('a newer Stop takes over: the older one stops trying', async () => {
    const r = rig({ ok: false });
    let second: Promise<boolean> | undefined;
    r.wait.mockImplementationOnce(async () => { second = r.belt.stop(); });
    expect(await r.belt.stop()).toBe(false);
    await second;
    // One attempt of the first, then all attempts of the second
    expect(r.sends()).toHaveLength(1 + STOP_ATTEMPTS);
  });

  it('asks for control again first when control was lost, without waiting for it', async () => {
    const r = rig();
    r.session.controlLost = true;
    r.session.beltStarted = true;
    await r.belt.stop();
    // Both urgent: nothing that is sent later (a Pause from the background) may displace the Stop
    expect(r.sends()).toEqual(['send 00 urgent', 'send 08 01 urgent']);
    expect(r.session.beltStarted).toBe(false);
  });
});

describe('pause', () => {
  it('ends the program and sends Pause urgently', async () => {
    const r = rig();
    r.session.beltStarted = true;
    expect(await r.belt.pause()).toBe(true);
    expect(r.calls).toEqual(['banner stop', 'abort run', 'governor reset', 'standstill disarm', 'send 08 02 urgent']);
    expect(r.session.beltStarted).toBe(false);
  });

  it('does nothing more than the housekeeping without a connection', async () => {
    const r = rig({ client: false });
    expect(await r.belt.pause()).toBe(false);
    expect(r.calls).toEqual(['banner stop', 'abort run', 'governor reset', 'standstill disarm']);
  });
});

describe('start', () => {
  it('takes control, sets the lowest speed and only then starts, and tells the banner', async () => {
    const r = rig();
    expect(await r.belt.start()).toBe(true);
    expect(r.calls).toEqual(['governor reset', 'standstill disarm', 'send 00', 'governor startSpeed', 'send 07', 'banner start']);
    expect(r.session.beltStarted).toBe(true);
  });

  it('if the treadmill does not take the starting speed, it still starts, but says so in the log', async () => {
    const r = rig({ startSpeedOk: false });
    expect(await r.belt.start()).toBe(true);
    expect(r.calls).toContain('send 07');
    expect(r.log).toHaveBeenCalledWith({ code: 'start-speed-failed' });
    expect(r.log).toHaveBeenCalledTimes(1);
    expect(r.session.beltStarted).toBe(true);
  });

  it('does not log anything when the starting speed was set', async () => {
    const r = rig();
    await r.belt.start();
    expect(r.log).not.toHaveBeenCalled();
  });

  it('does not end a program: the program is what starts the belt', async () => {
    const r = rig();
    await r.belt.start();
    expect(r.abortRun).not.toHaveBeenCalled();
  });

  it('forgets that control was lost once the request went through', async () => {
    const r = rig();
    r.session.controlLost = true;
    await r.belt.start();
    expect(r.session.controlLost).toBe(false);
  });

  it('keeps "control lost" if the request failed, and still tries to start', async () => {
    const r = rig({ ok: h => h !== '00' });
    r.session.controlLost = true;
    expect(await r.belt.start()).toBe(false);
    expect(r.session.controlLost).toBe(true);
    expect(r.calls).toContain('send 07');
    expect(r.calls).toContain('governor startSpeed');
  });

  it('does not mark the belt as started or show the banner if Start failed', async () => {
    const r = rig({ ok: h => h !== '07' });
    expect(await r.belt.start()).toBe(false);
    expect(r.session.beltStarted).toBe(false);
    expect(r.banner.startRequested).not.toHaveBeenCalled();
  });

  it('keeps a speed chosen while the belt stood: it asks for it again after Start, for the governor to ramp up to', async () => {
    const r = rig({ target: 5 });
    expect(await r.belt.start()).toBe(true);
    expect(r.calls).toEqual(['governor reset', 'standstill disarm', 'send 00', 'governor startSpeed', 'send 07', 'banner start', 'governor request 5']);
  });

  it('without a target, asks again for the speed asked for before the stop', async () => {
    const r = rig({ wanted: 3.5 });
    await r.belt.start();
    expect(r.calls.at(-1)).toBe('governor request 3.5');
  });

  it('a target chosen while standing wins over the speed before the stop', async () => {
    const r = rig({ target: 2, wanted: 3.5 });
    await r.belt.start();
    expect(r.calls.at(-1)).toBe('governor request 2');
  });

  it('asks for nothing when no speed was chosen', async () => {
    const r = rig();
    await r.belt.start();
    expect(r.governor.request).not.toHaveBeenCalled();
  });

  it('does not ask for the chosen speed if Start failed', async () => {
    const r = rig({ target: 5, ok: h => h !== '07' });
    await r.belt.start();
    expect(r.governor.request).not.toHaveBeenCalled();
  });

  it('a stop while starting also drops the chosen speed', async () => {
    const r = rig({ target: 5 });
    (r.governor.startSpeed as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { void r.belt.stop(); return true; });
    expect(await r.belt.start()).toBe(false);
    expect(r.governor.request).not.toHaveBeenCalled();
  });

  it('sends nothing without a connection', async () => {
    const r = rig({ client: false });
    expect(await r.belt.start()).toBe(false);
    expect(r.calls).toEqual([]);
  });

  it.each(['stop', 'pause'] as const)('a %s while the start is being sent wins: nothing of the start goes out after it', async kind => {
    let release!: (ok: boolean) => void;
    const gate = new Promise<boolean>(res => { release = res; });
    const r = rig({ ok: h => (h === '00' ? gate : true) });
    const starting = r.belt.start();
    await Promise.resolve();
    const stopping = r.belt[kind]();
    release(true);
    expect(await starting).toBe(false);
    expect(await stopping).toBe(true);
    expect(r.sends()).toEqual(['send 00', kind === 'stop' ? 'send 08 01 urgent' : 'send 08 02 urgent']);
    expect(r.governor.startSpeed).not.toHaveBeenCalled();
    expect(r.session.beltStarted).toBe(false);
    expect(r.banner.startRequested).not.toHaveBeenCalled();
  });

  it('a stop while the starting speed is being set: Start is not sent', async () => {
    const r = rig();
    let stopping: Promise<boolean> | undefined;
    (r.governor.startSpeed as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { stopping = r.belt.stop(); return false; });
    expect(await r.belt.start()).toBe(false);
    await stopping;
    expect(r.sends()).toEqual(['send 00', 'send 08 01 urgent']);
    expect(r.log).not.toHaveBeenCalled();
  });
});
