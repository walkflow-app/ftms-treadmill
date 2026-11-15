// What the connected treadmill can do with the incline, and the value that is sent.
// The treadmill is asked (FTMS features and the supported inclination range); nothing here is assumed.

import type { Features, Range } from '../protocol/ftms.ts';

/** Fitness Machine Feature bit 3: the incline is part of the treadmill data. */
const MACHINE_INCLINATION = 0x0008;
/** Target Setting Feature bit 1: the treadmill accepts a target incline. */
const TARGET_INCLINATION = 0x0002;

export interface InclineSupport {
  /** Set Inclination is accepted: the incline can be controlled from the app */
  settable: boolean;
  /** The incline comes with the treadmill data: it can be shown */
  reported: boolean;
}

/**
 * Features say what the treadmill supports. Without readable features the range characteristic is the only
 * hint, and an empty range (min = max) never counts as controllable.
 */
export function inclineSupport(features: Features | undefined, range: Range | undefined): InclineSupport {
  const usableRange = range !== undefined && range.max > range.min;
  if (!features) return { settable: usableRange, reported: false };
  const accepted = (features.target & TARGET_INCLINATION) !== 0;
  return {
    settable: accepted && (range === undefined || usableRange),
    reported: (features.machine & MACHINE_INCLINATION) !== 0,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Used when the treadmill takes an incline but its range could not be read: no downhill, nothing steeper than 15 % */
const SAFE_INCLINE_RANGE: Range = { min: 0, max: 15, step: 0.1 };
/** What Set Inclination can carry (sint16 in 0.1 %) */
const PROTOCOL_INCLINE = { min: -3276.8, max: 3276.7 };

/**
 * The value that is sent: inside the reported range (or SAFE_INCLINE_RANGE), with the 0.1 % resolution of the protocol.
 * NaN for a value that is no incline at all (not finite, or more than the protocol can carry): nothing is sent then.
 */
export function clampIncline(pct: number, range: Range | undefined): number {
  const v = round1(pct);
  if (!Number.isFinite(v) || v < PROTOCOL_INCLINE.min || v > PROTOCOL_INCLINE.max) return Number.NaN;
  const r = range ?? SAFE_INCLINE_RANGE;
  return Math.min(r.max, Math.max(r.min, v));
}
