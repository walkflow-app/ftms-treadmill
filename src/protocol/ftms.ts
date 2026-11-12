// FTMS protocol (Fitness Machine Service, 0x1826) as pure functions.
// No DOM and no BLE dependency, so everything can be tested without hardware.

export const FTMS_SERVICE = 0x1826;
export const HR_SERVICE = 0x180d;
export const DEVINFO_SERVICE = 0x180a;

export const CH = {
  feature: 0x2acc,
  treadmillData: 0x2acd,
  trainingStatus: 0x2ad3,
  speedRange: 0x2ad4,
  inclRange: 0x2ad5,
  control: 0x2ad9,
  machineStatus: 0x2ada,
  hr: 0x2a37,
} as const;

export const DEVINFO_CH = {
  manufacturer: 0x2a29,
  model: 0x2a24,
  firmware: 0x2a26,
} as const;

export const OP = {
  REQUEST_CONTROL: 0x00,
  SET_SPEED: 0x02,
  SET_INCL: 0x03,
  START: 0x07,
  STOP_PAUSE: 0x08,
  RESPONSE: 0x80,
} as const;

export const OP_NAMES: Record<number, string> = {
  0x00: 'Request Control',
  0x02: 'Set Speed',
  0x03: 'Set Inclination',
  0x07: 'Start/Resume',
  0x08: 'Stop/Pause',
};

export const FEAT_MACHINE = ['Avg Speed', 'Cadence', 'Total Distance', 'Inclination', 'Elevation Gain', 'Pace', 'Step Count', 'Resistance', 'Stride Count', 'Expended Energy', 'Heart Rate', 'MET', 'Elapsed Time', 'Remaining Time', 'Power', 'Force on Belt', 'User Data'];
export const FEAT_TARGET = ['Speed', 'Inclination', 'Resistance', 'Power', 'Heart Rate', 'Energy', 'Steps', 'Strides', 'Distance', 'Training Time', 'Time 2 HR zones', 'Time 3 HR zones', 'Time 5 HR zones', 'Bike Sim', 'Wheel Circ.', 'Spin Down', 'Cadence'];

// ---------- Helpers ----------

export function toBytes(data: DataView | Uint8Array | ArrayLike<number>): number[] {
  if (data instanceof DataView) return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
  return Array.from(data);
}

export function hex(data: DataView | Uint8Array | ArrayLike<number>): string {
  return toBytes(data).map(b => b.toString(16).padStart(2, '0')).join(' ');
}

export function bitNames(value: number, names: readonly string[]): string[] {
  return names.filter((_, i) => value & (1 << i));
}

export function dataView(bytes: ArrayLike<number>): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

// ---------- Treadmill Data (0x2ACD) ----------

export interface TreadmillData {
  /** km/h */
  speed?: number;
  /** km/h */
  avgSpeed?: number;
  /** metres */
  dist?: number;
  /** % */
  incl?: number;
  /** degrees */
  rampAngle?: number;
  /** metres */
  elevationGainPos?: number;
  /** metres */
  elevationGainNeg?: number;
  /** km/min (FTMS unit, 0.1) */
  pace?: number;
  avgPace?: number;
  /** total kcal */
  kcal?: number;
  kcalPerHour?: number;
  kcalPerMin?: number;
  /** bpm, 0 = no value */
  hr?: number;
  met?: number;
  /** seconds */
  time?: number;
}

/**
 * Parses a Treadmill Data packet. Fields are present only if their flag bit is set.
 * Bit 0 is inverted (0 = Instantaneous Speed present).
 * For truncated packets, the fields read up to that point are kept.
 */
export function parseTreadmillData(dv: DataView): TreadmillData {
  const r: TreadmillData = {};
  try {
    let o = 0;
    const flags = dv.getUint16(o, true); o += 2;
    if (!(flags & 0x0001)) { r.speed = dv.getUint16(o, true) / 100; o += 2; }
    if (flags & 0x0002) { r.avgSpeed = dv.getUint16(o, true) / 100; o += 2; }
    if (flags & 0x0004) { r.dist = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); o += 3; }
    if (flags & 0x0008) {
      r.incl = dv.getInt16(o, true) / 10;
      r.rampAngle = dv.getInt16(o + 2, true) / 10;
      o += 4;
    }
    if (flags & 0x0010) {
      r.elevationGainPos = dv.getUint16(o, true) / 10;
      r.elevationGainNeg = dv.getUint16(o + 2, true) / 10;
      o += 4;
    }
    if (flags & 0x0020) { r.pace = dv.getUint8(o) / 10; o += 1; }
    if (flags & 0x0040) { r.avgPace = dv.getUint8(o) / 10; o += 1; }
    if (flags & 0x0080) {
      const k = dv.getUint16(o, true);
      if (k !== 0xffff) r.kcal = k;
      const kh = dv.getUint16(o + 2, true);
      if (kh !== 0xffff) r.kcalPerHour = kh;
      const km = dv.getUint8(o + 4);
      if (km !== 0xff) r.kcalPerMin = km;
      o += 5;
    }
    if (flags & 0x0100) { r.hr = dv.getUint8(o); o += 1; }
    if (flags & 0x0200) { r.met = dv.getUint8(o) / 10; o += 1; }
    if (flags & 0x0400) { r.time = dv.getUint16(o, true); o += 2; }
  } catch {
    // incomplete packet: keep the fields read so far
  }
  return r;
}

// ---------- Heart Rate Measurement (0x2A37) ----------

export function parseHeartRate(dv: DataView): number {
  return (dv.getUint8(0) & 1) ? dv.getUint16(1, true) : dv.getUint8(1);
}

// ---------- Feature / Ranges ----------

export interface Features {
  machine: number;
  target: number;
  machineNames: string[];
  targetNames: string[];
}

export function parseFeatures(dv: DataView): Features {
  const machine = dv.getUint32(0, true);
  const target = dv.getUint32(4, true);
  return { machine, target, machineNames: bitNames(machine, FEAT_MACHINE), targetNames: bitNames(target, FEAT_TARGET) };
}

export interface Range {
  min: number;
  max: number;
  step: number;
}

/** Supported Speed Range (0x2AD4): uint16 min, max, step in 0.01 km/h */
export function parseSpeedRange(dv: DataView): Range {
  return { min: dv.getUint16(0, true) / 100, max: dv.getUint16(2, true) / 100, step: dv.getUint16(4, true) / 100 };
}

/** Supported Inclination Range (0x2AD5): sint16 min, sint16 max, uint16 step in 0.1 % */
export function parseInclinationRange(dv: DataView): Range {
  return { min: dv.getInt16(0, true) / 10, max: dv.getInt16(2, true) / 10, step: dv.getUint16(4, true) / 10 };
}

// ---------- Control Point (0x2AD9): commands ----------

export function cmdRequestControl(): Uint8Array {
  return new Uint8Array([OP.REQUEST_CONTROL]);
}

export function cmdStart(): Uint8Array {
  return new Uint8Array([OP.START]);
}

export function cmdStop(): Uint8Array {
  return new Uint8Array([OP.STOP_PAUSE, 0x01]);
}

export function cmdPause(): Uint8Array {
  return new Uint8Array([OP.STOP_PAUSE, 0x02]);
}

/** Target speed, uint16 LE in 0.01 km/h */
export function cmdSetSpeed(kmh: number): Uint8Array {
  const v = Math.round(kmh * 100);
  if (!Number.isFinite(v) || v < 0 || v > 0xffff) throw new RangeError(`Speed outside uint16: ${kmh}`);
  return new Uint8Array([OP.SET_SPEED, v & 0xff, (v >> 8) & 0xff]);
}

/** Target incline, sint16 LE in 0.1 % */
export function cmdSetInclination(pct: number): Uint8Array {
  const v = Math.round(pct * 10);
  if (!Number.isFinite(v) || v < -0x8000 || v > 0x7fff) throw new RangeError(`Incline outside sint16: ${pct}`);
  const dv = new DataView(new ArrayBuffer(3));
  dv.setUint8(0, OP.SET_INCL);
  dv.setInt16(1, v, true);
  return new Uint8Array(dv.buffer);
}

/** Reads the target speed from a raw Set Speed command, otherwise null. */
export function decodeSetSpeed(bytes: ArrayLike<number>): number | null {
  if (bytes.length < 3 || bytes[0] !== OP.SET_SPEED) return null;
  return ((bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8)) / 100;
}

// ---------- Control Point: responses ----------

export interface ControlPointResponse {
  requestOp: number;
  result: number;
}

export function parseControlPointResponse(dv: DataView): ControlPointResponse | null {
  if (dv.byteLength < 3 || dv.getUint8(0) !== OP.RESPONSE) return null;
  return { requestOp: dv.getUint8(1), result: dv.getUint8(2) };
}

// ---------- Machine Status (0x2ADA) ----------

export type MachineEvent =
  | { kind: 'reset' }
  | { kind: 'stopped' }
  | { kind: 'paused' }
  | { kind: 'safety-key' }
  | { kind: 'started' }
  | { kind: 'target-speed'; kmh: number }
  | { kind: 'target-incline'; pct: number }
  | { kind: 'control-lost' }
  | { kind: 'other'; op: number };

export function parseMachineStatus(dv: DataView): MachineEvent | null {
  if (dv.byteLength < 1) return null;
  const op = dv.getUint8(0);
  switch (op) {
    case 0x01: return { kind: 'reset' };
    // Parameter 0x02 = pause; anything else (including none) counts as stop, to be safe
    case 0x02: return dv.byteLength >= 2 && dv.getUint8(1) === 0x02 ? { kind: 'paused' } : { kind: 'stopped' };
    case 0x03: return { kind: 'safety-key' };
    case 0x04: return { kind: 'started' };
    case 0x05: return dv.byteLength >= 3 ? { kind: 'target-speed', kmh: dv.getUint16(1, true) / 100 } : { kind: 'other', op };
    case 0x06: return dv.byteLength >= 3 ? { kind: 'target-incline', pct: dv.getInt16(1, true) / 10 } : { kind: 'other', op };
    case 0xff: return { kind: 'control-lost' };
    default: return { kind: 'other', op };
  }
}

// ---------- Training Status (0x2AD3) ----------

const TRAINING_STATUS: Record<number, string> = {
  0x00: 'Other', 0x01: 'Idle', 0x02: 'Warming Up', 0x03: 'Low Intensity Interval', 0x04: 'High Intensity Interval',
  0x05: 'Recovery Interval', 0x06: 'Isometric', 0x07: 'Heart Rate Control', 0x08: 'Fitness Test',
  0x09: 'Speed Outside Control Region (Low)', 0x0a: 'Speed Outside Control Region (High)', 0x0b: 'Cool Down',
  0x0c: 'Watt Control', 0x0d: 'Manual Mode', 0x0e: 'Pre-Workout', 0x0f: 'Post-Workout',
};

export function parseTrainingStatus(dv: DataView): { status: number; text: string } | null {
  if (dv.byteLength < 2) return null;
  const status = dv.getUint8(1);
  return { status, text: TRAINING_STATUS[status] ?? `0x${status.toString(16)}` };
}

// ---------- Building Treadmill Data (simulator, tests) ----------

export function buildTreadmillData(d: TreadmillData): Uint8Array {
  const out: number[] = [];
  const u16 = (v: number) => { const x = Math.round(v) & 0xffff; out.push(x & 0xff, x >> 8); };
  let flags = 0;
  if (d.speed === undefined) flags |= 0x0001; else u16(d.speed * 100);
  if (d.avgSpeed !== undefined) { flags |= 0x0002; u16(d.avgSpeed * 100); }
  if (d.dist !== undefined) { flags |= 0x0004; const v = Math.round(d.dist); out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff); }
  if (d.incl !== undefined) { flags |= 0x0008; u16(d.incl * 10); u16((d.rampAngle ?? 0) * 10); }
  if (d.kcal !== undefined) { flags |= 0x0080; u16(d.kcal); u16(d.kcalPerHour ?? 0xffff); out.push(d.kcalPerMin ?? 0xff); }
  if (d.hr !== undefined) { flags |= 0x0100; out.push(d.hr & 0xff); }
  if (d.time !== undefined) { flags |= 0x0400; u16(d.time); }
  return new Uint8Array([flags & 0xff, flags >> 8, ...out]);
}
