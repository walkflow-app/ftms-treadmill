import { describe, expect, it, vi } from 'vitest';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import { BeltState } from './belt-state.ts';
import { setupReports, type ReportsHost } from './reports.ts';

const dv = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

function rig(opts: { program?: boolean; standstillFires?: boolean } = {}) {
  const calls: string[] = [];
  const session = new BeltState();
  const phase = {
    stopRequested: vi.fn(() => calls.push('phase stop')),
    speed: vi.fn(),
  } satisfies ReportsHost['phase'];
  const governor = {
    reset: vi.fn(() => calls.push('governor reset')),
    noteMeasured: vi.fn(),
    commandRefused: vi.fn(() => calls.push('governor refused')),
  } as unknown as SpeedGovernor;
  const standstill = {
    disarm: vi.fn(() => calls.push('standstill disarm')),
    feed: vi.fn(() => opts.standstillFires ?? false),
  } as unknown as StandstillDetector;
  const host: ReportsHost = {
    session, phase, governor, standstill,
    now: () => 5000,
    programActive: () => opts.program ?? false,
    ended: vi.fn(() => { calls.push('ended'); }),
    stopFailed: vi.fn(),
    notice: vi.fn(),
    data: vi.fn(() => { calls.push('data'); }),
    machineStatus: vi.fn(() => { calls.push('machine status'); }),
    controlResponse: vi.fn(() => { calls.push('control response'); }),
  };
  return { reports: setupReports(host), host, session, calls, phase, governor, standstill };
}

describe('Machine Status', () => {
  it.each([
    ['stopped on the treadmill', [0x02, 0x01], 'machine-stopped'],
    ['paused on the treadmill', [0x02, 0x02], 'machine-paused'],
    ['safety key', [0x03], 'safety-key'],
  ] as const)('%s: the belt is no longer ours, the program is told, the ramp is forgotten', (_name, bytes, reason) => {
    const r = rig({ program: true });
    r.session.beltStarted = true;
    r.reports.machineStatus(dv(...bytes));
    expect(r.session.beltStarted).toBe(false);
    expect(r.host.ended).toHaveBeenCalledWith(reason);
    expect(r.calls).toEqual(['machine status', 'phase stop', 'ended', 'governor reset', 'standstill disarm']);
  });

  it('hands every status on, with its bytes, also one it does not know', () => {
    const r = rig();
    r.reports.machineStatus(dv(0x7e));
    expect(r.host.machineStatus).toHaveBeenCalledWith({ event: { kind: 'other', op: 0x7e }, hex: '7e' });
    expect(r.host.ended).not.toHaveBeenCalled();
  });

  it('started: the belt counts as started', () => {
    const r = rig();
    r.reports.machineStatus(dv(0x04));
    expect(r.session.beltStarted).toBe(true);
  });

  it('control lost: remembered, so the next stop asks for control first', () => {
    const r = rig();
    r.reports.machineStatus(dv(0xff));
    expect(r.session.controlLost).toBe(true);
  });

  it('a target speed change on the device changes nothing here', () => {
    const r = rig({ program: true });
    r.session.beltStarted = true;
    r.reports.machineStatus(dv(0x05, 0xc8, 0x00));
    expect(r.session.beltStarted).toBe(true);
    expect(r.host.ended).not.toHaveBeenCalled();
  });
});

describe('Control Point responses', () => {
  it('hands every answer on before acting on it', () => {
    const r = rig();
    r.reports.controlResponse({ requestOp: 0x02, result: 3 });
    expect(r.calls).toEqual(['control response', 'governor refused']);
  });

  it('a command the treadmill accepted changes nothing', () => {
    const r = rig();
    r.session.lastMeasured = 3;
    for (const op of [0x00, 0x02, 0x07, 0x08]) r.reports.controlResponse({ requestOp: op, result: 1 });
    expect(r.host.stopFailed).not.toHaveBeenCalled();
    expect(r.governor.commandRefused).not.toHaveBeenCalled();
    expect(r.session.controlLost).toBe(false);
  });

  it('a Stop the treadmill refused while the belt moves: the person is told to stop it on the treadmill', () => {
    const r = rig();
    r.session.lastMeasured = 3;
    r.reports.controlResponse({ requestOp: 0x08, result: 4 });
    expect(r.host.stopFailed).toHaveBeenCalledWith(true);
  });

  it('a Stop the treadmill refused while the belt stands is nothing to warn about', () => {
    const r = rig();
    r.session.lastMeasured = 0;
    r.reports.controlResponse({ requestOp: 0x08, result: 4 });
    expect(r.host.stopFailed).not.toHaveBeenCalled();
  });

  it('a speed the treadmill refused: the ramp ends and the app is told', () => {
    const r = rig();
    r.reports.controlResponse({ requestOp: 0x02, result: 3 });
    expect(r.governor.commandRefused).toHaveBeenCalledTimes(1);
    expect(r.host.notice).toHaveBeenCalledWith({ code: 'speed-refused' });
  });

  it('control that was refused counts as lost, so the next stop asks for it first', () => {
    const r = rig();
    r.reports.controlResponse({ requestOp: 0x00, result: 5 });
    expect(r.session.controlLost).toBe(true);
  });
});

describe('Treadmill Data', () => {
  it('keeps the measured speed, hands it to the governor and the phase, then hands the data on', () => {
    const r = rig();
    r.reports.data({ speed: 2.5, dist: 120 });
    expect(r.governor.noteMeasured).toHaveBeenCalledWith(2.5);
    expect(r.phase.speed).toHaveBeenCalledWith(2.5, 5000);
    expect(r.session.lastMeasured).toBe(2.5);
    expect(r.session.lastMeasuredAt).toBe(5000);
    expect(r.host.data).toHaveBeenCalledWith({ speed: 2.5, dist: 120 });
  });

  it('data without a speed changes nothing about the belt', () => {
    const r = rig();
    r.reports.data({ dist: 120 });
    expect(r.governor.noteMeasured).not.toHaveBeenCalled();
    expect(r.session.lastMeasured).toBeUndefined();
  });

  it('standing still during a program ends it and forgets the ramp, before the data goes on', () => {
    const r = rig({ program: true, standstillFires: true });
    r.reports.data({ speed: 0 });
    expect(r.host.ended).toHaveBeenCalledWith('standstill');
    expect(r.calls).toEqual(['ended', 'governor reset', 'data']);
  });

  it('standing still without a program ends nothing', () => {
    const r = rig({ program: false, standstillFires: true });
    r.reports.data({ speed: 0 });
    expect(r.host.ended).not.toHaveBeenCalled();
    expect(r.governor.reset).not.toHaveBeenCalled();
  });
});
