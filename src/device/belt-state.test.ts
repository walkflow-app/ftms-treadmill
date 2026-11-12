import { describe, expect, it, vi } from 'vitest';
import type { TreadmillClient } from './ble.ts';
import { BeltState } from './belt-state.ts';

const fakeClient = (connected: boolean, ok = true) => {
  const send = vi.fn(async () => ok);
  return { client: { connected, send } as unknown as TreadmillClient, send };
};

describe('BeltState', () => {
  it('is not connected without a client or with a client that is not', () => {
    const s = new BeltState();
    expect(s.connected()).toBe(false);
    s.client = fakeClient(false).client;
    expect(s.connected()).toBe(false);
    s.client = fakeClient(true).client;
    expect(s.connected()).toBe(true);
  });

  it('sends nothing without a client', async () => {
    expect(await new BeltState().send(new Uint8Array([0x08, 0x01]))).toBe(false);
  });

  it('passes the command and its options on to the client', async () => {
    const s = new BeltState();
    const { client, send } = fakeClient(true);
    s.client = client;
    const bytes = new Uint8Array([0x08, 0x01]);
    expect(await s.send(bytes, { urgent: true })).toBe(true);
    expect(send).toHaveBeenCalledWith(bytes, { urgent: true });
  });

  it('thinks the belt may be running when it was started by the app or was measured moving', () => {
    const s = new BeltState();
    expect(s.maybeRunning()).toBe(false);
    s.lastMeasured = 0;
    expect(s.maybeRunning()).toBe(false);
    s.lastMeasured = 2.5;
    expect(s.maybeRunning()).toBe(true);
    s.lastMeasured = 0;
    s.beltStarted = true;
    expect(s.maybeRunning()).toBe(true);
  });

  it('forgets what it knew about the belt', () => {
    const s = new BeltState();
    s.beltStarted = true;
    s.lastMeasured = 3;
    s.controlLost = true;
    s.lastMeasuredAt = 123;
    s.forgetBelt();
    expect([s.beltStarted, s.lastMeasured, s.controlLost]).toEqual([false, undefined, false]);
    expect(s.lastMeasuredAt).toBe(123);
  });

  it('begins a connection with nothing known, and keeps what the treadmill reports from then on', () => {
    const s = new BeltState();
    s.beltStarted = true;
    s.lastMeasured = 3;
    s.controlLost = true;
    const { client } = fakeClient(true);
    s.begin(client);
    expect(s.client).toBe(client);
    expect([s.beltStarted, s.lastMeasured, s.controlLost]).toEqual([false, undefined, false]);
    // a reading that arrives while the connection is still being set up is not wiped by anything later
    s.lastMeasured = 4.2;
    s.beltStarted = true;
    expect(s.maybeRunning()).toBe(true);
  });
});
