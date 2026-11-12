import { describe, expect, it } from 'vitest';
import { parseFeatures, type Features, type Range } from '../protocol/ftms.ts';
import { clampIncline, inclineSupport } from './incline.ts';

const feat = (machine: number, target: number): Features => parseFeatures(new DataView(new Uint8Array([
  machine & 0xff, (machine >> 8) & 0xff, 0, 0, target & 0xff, (target >> 8) & 0xff, 0, 0,
]).buffer));
const range = (min: number, max: number, step = 1): Range => ({ min, max, step });

describe('inclineSupport', () => {
  it('can set the incline when the treadmill lists Inclination among the settings it accepts', () => {
    expect(inclineSupport(feat(0x0008, 0x0002), range(0, 10)).settable).toBe(true);
    expect(inclineSupport(feat(0, 0x0003), undefined).settable).toBe(true);
  });

  it('reports the incline in its data when the machine feature says so', () => {
    expect(inclineSupport(feat(0x0008, 0), undefined)).toEqual({ settable: false, reported: true });
    expect(inclineSupport(feat(0x0008, 0x0002), range(0, 10)).reported).toBe(true);
  });

  it('has no incline at all when the features exclude it, whatever the range characteristic says', () => {
    expect(inclineSupport(feat(0x0004, 0x0001), range(0, 15))).toEqual({ settable: false, reported: false });
  });

  it('does not offer the incline when the treadmill accepts it but its range is empty', () => {
    expect(inclineSupport(feat(0x0008, 0x0002), range(0, 0)).settable).toBe(false);
    expect(inclineSupport(feat(0x0008, 0x0002), range(5, 5)).settable).toBe(false);
  });

  it('falls back to the range when the features cannot be read, and to nothing when that fails too', () => {
    expect(inclineSupport(undefined, range(0, 10)).settable).toBe(true);
    expect(inclineSupport(undefined, range(0, 0)).settable).toBe(false);
    expect(inclineSupport(undefined, undefined)).toEqual({ settable: false, reported: false });
  });
});

describe('clampIncline', () => {
  it('keeps a value inside the range the treadmill reported', () => {
    expect(clampIncline(4, range(0, 10))).toBe(4);
    expect(clampIncline(12, range(0, 10))).toBe(10);
    expect(clampIncline(-3, range(0, 10))).toBe(0);
  });

  it('rounds to 0.1 and leaves values alone when there is no range', () => {
    expect(clampIncline(2.04, undefined)).toBe(2);
    expect(clampIncline(7, undefined)).toBe(7);
  });

  it('does not let a value that is not a number through', () => {
    expect(Number.isNaN(clampIncline(NaN, range(0, 10)))).toBe(true);
  });
});
