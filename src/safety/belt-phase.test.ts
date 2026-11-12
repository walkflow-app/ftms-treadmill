import { describe, expect, it } from 'vitest';
import { BeltPhaseTracker, START_MS, STOP_MAX_MS } from './belt-phase.ts';

const tracker = () => { const p = new BeltPhaseTracker(); p.setConnected(true); return p; };

describe('BeltPhaseTracker', () => {
  it('knows nothing without a connection or before the first reading', () => {
    const p = new BeltPhaseTracker();
    expect(p.phase(0)).toBe('unknown');
    p.setConnected(true);
    expect(p.phase(0)).toBe('unknown');
  });

  it('standing or running from the measured speed', () => {
    const p = tracker();
    p.speed(0, 0);
    expect(p.phase(0)).toBe('standing');
    p.speed(2, 100);
    expect(p.phase(100)).toBe('running');
  });

  it('starting from a sent Start until the belt moves', () => {
    const p = tracker();
    p.speed(0, 0);
    p.startRequested(1000);
    expect(p.phase(1000)).toBe('starting');
    p.speed(0.2, 2000);
    expect(p.phase(2000)).toBe('starting');
    p.speed(0.3, 3000);
    expect(p.phase(3000)).toBe('running');
  });

  it('starting ends after the countdown even if the belt never moves', () => {
    const p = tracker();
    p.speed(0, 0);
    p.startRequested(0);
    expect(p.phase(START_MS - 1)).toBe('starting');
    expect(p.phase(START_MS)).toBe('standing');
  });

  it('stopping from a stop on a moving belt until it stands', () => {
    const p = tracker();
    p.speed(4, 0);
    p.stopRequested(1000);
    expect(p.phase(1000)).toBe('stopping');
    p.speed(1, 2000);
    expect(p.phase(2000)).toBe('stopping');
    p.speed(0, 3000);
    expect(p.phase(3000)).toBe('standing');
  });

  it('a stop on a belt that stands or is not known is not stopping', () => {
    const p = tracker();
    p.stopRequested(0);
    expect(p.phase(0)).toBe('unknown');
    p.speed(0, 0);
    p.stopRequested(100);
    expect(p.phase(100)).toBe('standing');
  });

  it('gives a stop up when the belt is never reported standing', () => {
    const p = tracker();
    p.speed(4, 0);
    p.stopRequested(0);
    expect(p.phase(STOP_MAX_MS - 1)).toBe('stopping');
    expect(p.phase(STOP_MAX_MS)).toBe('running');
  });

  it('a stop ends a start, and a start ends a stop', () => {
    const p = tracker();
    p.speed(0, 0);
    p.startRequested(0);
    p.stopRequested(100);
    expect(p.phase(100)).toBe('standing');
    p.speed(3, 200);
    p.stopRequested(300);
    p.startRequested(400);
    expect(p.phase(400)).toBe('starting');
  });

  it('forgets everything when the connection is lost', () => {
    const p = tracker();
    p.speed(3, 0);
    p.stopRequested(0);
    p.setConnected(false);
    expect(p.phase(10)).toBe('unknown');
    p.setConnected(true);
    expect(p.phase(20)).toBe('unknown');
  });
});
