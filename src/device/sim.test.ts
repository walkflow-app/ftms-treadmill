import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TreadmillClient, type TreadmillEvents } from './ble.ts';
import type { Notice } from '../protocol/notice.ts';
import { cmdPause, cmdRequestControl, cmdSetInclination, cmdSetSpeed, cmdStart, cmdStop, OP, parseMachineStatus, type ControlPointResponse, type TreadmillData } from '../protocol/ftms.ts';
import { inclineSupport } from '../safety/incline.ts';
import { SimulatorAdapter } from './sim.ts';

/** Control Point result codes (FTMS) */
const RESULT_OK = 1, INVALID_PARAMETER = 3, NOT_PERMITTED = 5;

function setup(opts = {}) {
  const sim = new SimulatorAdapter(opts);
  const notices: Notice[] = [];
  const responses: ControlPointResponse[] = [];
  const data: TreadmillData[] = [];
  const machine: string[] = [];
  const ev: TreadmillEvents = {
    log: vi.fn(),
    notice: n => notices.push(n),
    data: d => data.push(d),
    heartRate: vi.fn(),
    machineStatus: d => machine.push(parseMachineStatus(d)?.kind ?? '?'),
    trainingStatus: vi.fn(),
    controlResponse: r => responses.push(r),
    disconnected: vi.fn(),
  };
  const client = new TreadmillClient(sim, ev);
  return { sim, client, notices, responses, data, machine, ev, last: () => data.at(-1)! };
}

describe('Simulator + TreadmillClient', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('connects like a real FTMS treadmill', async () => {
    const { client, notices } = setup();
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(500);
    const info = await p;
    expect(info.speedRange).toEqual({ min: 1, max: 8, step: 0.1 });
    expect(info.inclRange).toEqual({ min: 0, max: 10, step: 1 });
    expect(info.features?.targetNames).toEqual(['Speed', 'Inclination']);
    expect(info.hasHeartRate).toBe(false);
    expect(notices).toContainEqual({ code: 'device-info', field: 'manufacturer', value: 'Walkflow' });
  });

  it('tells that it can set the incline, as the app asks the treadmill before it shows the controls', async () => {
    const { client } = setup();
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(500);
    const info = await p;
    expect(inclineSupport(info.features, info.inclRange)).toEqual({ settable: true, reported: true });
  });

  it('can be a treadmill without incline: no feature, no range, nothing in the data, Set Inclination refused', async () => {
    const { client, responses, last } = setup({ incline: false });
    const p = client.connect();
    await vi.advanceTimersByTimeAsync(500);
    const info = await p;
    expect(info.inclRange).toBeUndefined();
    expect(info.features?.targetNames).toEqual(['Speed']);
    expect(inclineSupport(info.features, info.inclRange)).toEqual({ settable: false, reported: false });
    void client.send(cmdRequestControl());
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(5000);
    expect(last().incl).toBeUndefined();
    void client.send(cmdSetInclination(2));
    await vi.advanceTimersByTimeAsync(500);
    expect(responses.some(r => r.requestOp === OP.SET_INCL && r.result !== RESULT_OK)).toBe(true);
  });

  it('without Request Control: not permitted', async () => {
    const { client, responses } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(100);
    expect(responses).toContainEqual({ requestOp: OP.START, result: NOT_PERMITTED });
  });

  it('start → countdown → minimum speed, then Set Speed, stop', async () => {
    const { client, sim, last, machine, responses } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdRequestControl());
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(2000);
    expect(sim.belt.state).toBe('countdown');
    expect(last().speed).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(last().speed).toBe(1);
    void client.send(cmdSetSpeed(3));
    await vi.advanceTimersByTimeAsync(3000);
    expect(last().speed).toBe(3);
    expect(last().dist).toBeGreaterThan(0);
    expect(responses).toContainEqual({ requestOp: OP.SET_SPEED, result: RESULT_OK });
    void client.send(cmdStop());
    await vi.advanceTimersByTimeAsync(3000);
    expect(last().speed).toBe(0);
    expect(machine).toEqual(['started', 'target-speed', 'stopped']);
  });

  it('Set Speed outside the range → invalid parameter', async () => {
    const { client, responses } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdRequestControl());
    void client.send(cmdSetSpeed(9));
    void client.send(cmdSetInclination(3));
    await vi.advanceTimersByTimeAsync(200);
    expect(responses).toContainEqual({ requestOp: OP.SET_SPEED, result: INVALID_PARAMETER });
    expect(responses).toContainEqual({ requestOp: OP.SET_INCL, result: RESULT_OK });
  });

  it('pause keeps the distance, stop resets it on the next start', async () => {
    const { client, sim } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdRequestControl());
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(10_000);
    void client.send(cmdPause());
    await vi.advanceTimersByTimeAsync(2000);
    const d = sim.belt.dist;
    expect(sim.belt.state).toBe('paused');
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(5000);
    expect(sim.belt.dist).toBeGreaterThan(d);
    void client.send(cmdStop());
    await vi.advanceTimersByTimeAsync(2000);
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(100);
    expect(sim.belt.dist).toBe(0);
  });

  it('connection loss: the simulated belt keeps running', async () => {
    const { client, sim, ev } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdRequestControl());
    void client.send(cmdStart());
    void client.send(cmdSetSpeed(3));
    await vi.advanceTimersByTimeAsync(10_000);
    sim.simulateConnectionLoss();
    expect(ev.disconnected).toHaveBeenCalledTimes(1);
    expect(client.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sim.belt.speed).toBe(3);
    await expect(client.send(cmdStop())).resolves.toBe(false);
    sim.dispose();
  });

  it('safety key: the belt stops at once, Machine Status reports it', async () => {
    const { client, sim, machine } = setup();
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500); await p;
    void client.send(cmdRequestControl());
    void client.send(cmdStart());
    await vi.advanceTimersByTimeAsync(6000);
    sim.pullSafetyKey();
    expect(sim.belt.speed).toBe(0);
    expect(machine.at(-1)).toBe('safety-key');
  });

  it('optionally with a heart rate service', async () => {
    const { client, ev } = setup({ heartRate: true });
    const p = client.connect(); await vi.advanceTimersByTimeAsync(500);
    expect((await p).hasHeartRate).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ev.heartRate).toHaveBeenCalled();
  });
});
