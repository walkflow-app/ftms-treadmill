import { describe, expect, it } from 'vitest';
import {
  buildTreadmillData, cmdPause, cmdRequestControl, parseMachineStatus, parseTrainingStatus, cmdSetInclination, cmdSetSpeed, cmdStart, cmdStop, dataView,
  decodeSetSpeed, hex, parseControlPointResponse, parseFeatures,
  parseHeartRate, parseInclinationRange, parseSpeedRange, parseTreadmillData, toBytes,
} from './ftms.ts';

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

describe('Treadmill Data', () => {
  it('reads Instantaneous Speed if bit 0 = 0', () => {
    expect(parseTreadmillData(dataView([0x00, 0x00, 0x2c, 0x01]))).toEqual({ speed: 3 });
  });

  it('has no speed if bit 0 = 1', () => {
    expect(parseTreadmillData(dataView([0x01, 0x00]))).toEqual({});
  });

  it('reads all fields up to Elapsed Time in the right order', () => {
    const flags = 0x07fe; // bits 1..10, bit 0 = 0 → speed present
    const bytes = [
      ...le16(flags),
      ...le16(350), // speed 3.50
      ...le16(320), // avg speed 3.20
      0x10, 0x27, 0x00, // dist 10000 m
      ...le16(25), ...le16(0xfffb), // incl 2.5 %, ramp -0.5°
      ...le16(123), ...le16(4), // elevation +12.3 / -0.4 m
      12, 11, // pace, avg pace
      ...le16(87), ...le16(300), 5, // kcal, kcal/h, kcal/min
      98, // hr
      34, // MET 3.4
      ...le16(754), // time
    ];
    expect(parseTreadmillData(dataView(bytes))).toEqual({
      speed: 3.5, avgSpeed: 3.2, dist: 10000, incl: 2.5, rampAngle: -0.5,
      elevationGainPos: 12.3, elevationGainNeg: 0.4, pace: 1.2, avgPace: 1.1,
      kcal: 87, kcalPerHour: 300, kcalPerMin: 5, hr: 98, met: 3.4, time: 754,
    });
  });

  it('skips fields that are not set (speed, distance, energy, time)', () => {
    const flags = 0x0004 | 0x0080 | 0x0400;
    const bytes = [...le16(flags), ...le16(410), 0xe8, 0x03, 0x00, ...le16(12), ...le16(0xffff), 0xff, ...le16(60)];
    expect(parseTreadmillData(dataView(bytes))).toEqual({ speed: 4.1, dist: 1000, kcal: 12, time: 60 });
  });

  it('negative incline', () => {
    const bytes = [...le16(0x0009), ...le16(0xfff6), 0, 0];
    expect(parseTreadmillData(dataView(bytes))).toEqual({ incl: -1, rampAngle: 0 });
  });

  it('kcal 0xFFFF means: no value', () => {
    const bytes = [...le16(0x0081), ...le16(0xffff), ...le16(0xffff), 0xff];
    expect(parseTreadmillData(dataView(bytes))).toEqual({});
  });

  it('passes heart rate 0 through (the UI decides whether to show it)', () => {
    expect(parseTreadmillData(dataView([...le16(0x0101), 0]))).toEqual({ hr: 0 });
  });

  it('keeps the fields already read when a packet is truncated', () => {
    const bytes = [...le16(0x0404), ...le16(250), 0x64, 0x00, 0x00, 0x05]; // time is half missing
    expect(parseTreadmillData(dataView(bytes))).toEqual({ speed: 2.5, dist: 100 });
  });

  it('never throws, not even for an empty packet', () => {
    expect(parseTreadmillData(dataView([]))).toEqual({});
    expect(parseTreadmillData(dataView([0x00]))).toEqual({});
  });
});

describe('Heart Rate Measurement', () => {
  it('uint8 format', () => expect(parseHeartRate(dataView([0x00, 72]))).toBe(72));
  it('uint16 format', () => expect(parseHeartRate(dataView([0x01, 0x2c, 0x01]))).toBe(300));
});

describe('features and ranges', () => {
  it('feature bits', () => {
    const f = parseFeatures(dataView([0x0c, 0x14, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00]));
    expect(f.machineNames).toEqual(['Total Distance', 'Inclination', 'Heart Rate', 'Elapsed Time']);
    expect(f.targetNames).toEqual(['Speed', 'Inclination']);
  });

  it('Speed Range', () => {
    expect(parseSpeedRange(dataView([...le16(100), ...le16(600), ...le16(10)]))).toEqual({ min: 1, max: 6, step: 0.1 });
  });

  it('Inclination Range with a negative minimum', () => {
    expect(parseInclinationRange(dataView([...le16(0xffec), ...le16(150), ...le16(5)]))).toEqual({ min: -2, max: 15, step: 0.5 });
  });
});

describe('Control Point commands', () => {
  it('Request Control, Start, Stop, Pause', () => {
    expect(toBytes(cmdRequestControl())).toEqual([0x00]);
    expect(toBytes(cmdStart())).toEqual([0x07]);
    expect(toBytes(cmdStop())).toEqual([0x08, 0x01]);
    expect(toBytes(cmdPause())).toEqual([0x08, 0x02]);
  });

  it('Set Speed 3.0 km/h = 02 2C 01', () => {
    expect(hex(cmdSetSpeed(3))).toBe('02 2c 01');
  });

  it('Set Speed rounds to 0.01 km/h', () => {
    expect(toBytes(cmdSetSpeed(4.3))).toEqual([0x02, ...le16(430)]);
    expect(toBytes(cmdSetSpeed(0.1 + 0.2))).toEqual([0x02, ...le16(30)]);
  });

  it('Set Speed rejects values outside uint16', () => {
    expect(() => cmdSetSpeed(-1)).toThrow(RangeError);
    expect(() => cmdSetSpeed(700)).toThrow(RangeError);
    expect(() => cmdSetSpeed(Number.NaN)).toThrow(RangeError);
  });

  it('Set Inclination as sint16 in 0.1 %', () => {
    expect(toBytes(cmdSetInclination(5))).toEqual([0x03, ...le16(50)]);
    expect(toBytes(cmdSetInclination(-1.5))).toEqual([0x03, ...le16(0xfff1)]);
  });

  it('decodeSetSpeed', () => {
    expect(decodeSetSpeed([0x02, 0x2c, 0x01])).toBe(3);
    expect(decodeSetSpeed([0x02, 0x2c])).toBeNull();
    expect(decodeSetSpeed([0x07])).toBeNull();
  });
});

describe('Control Point responses', () => {
  it('80 <op> <result>', () => {
    const r = parseControlPointResponse(dataView([0x80, 0x02, 0x01]));
    expect(r).toEqual({ requestOp: 2, result: 1 });
  });

  it('no response packet → null', () => {
    expect(parseControlPointResponse(dataView([0x07]))).toBeNull();
    expect(parseControlPointResponse(dataView([0x80, 0x02]))).toBeNull();
  });
});

describe('Machine Status (0x2ADA)', () => {
  it('detects stop, pause, safety key, start and loss of control', () => {
    expect(parseMachineStatus(dataView([0x02, 0x01]))).toEqual({ kind: 'stopped' });
    expect(parseMachineStatus(dataView([0x02, 0x02]))).toEqual({ kind: 'paused' });
    expect(parseMachineStatus(dataView([0x03]))).toEqual({ kind: 'safety-key' });
    expect(parseMachineStatus(dataView([0x04]))).toEqual({ kind: 'started' });
    expect(parseMachineStatus(dataView([0xff]))).toEqual({ kind: 'control-lost' });
    expect(parseMachineStatus(dataView([0x01]))).toEqual({ kind: 'reset' });
  });

  it('target values', () => {
    expect(parseMachineStatus(dataView([0x05, 0x2c, 0x01]))).toEqual({ kind: 'target-speed', kmh: 3 });
    expect(parseMachineStatus(dataView([0x06, 0xf6, 0xff]))).toEqual({ kind: 'target-incline', pct: -1 });
  });

  it('unknown and broken packets', () => {
    expect(parseMachineStatus(dataView([0x42]))).toEqual({ kind: 'other', op: 0x42 });
    expect(parseMachineStatus(dataView([0x05, 0x2c]))).toEqual({ kind: 'other', op: 0x05 });
    expect(parseMachineStatus(dataView([0x02]))).toEqual({ kind: 'stopped' }); // without a parameter: stopped, to be safe
    expect(parseMachineStatus(dataView([]))).toBeNull();
  });
});

describe('Training Status (0x2AD3)', () => {
  it('status code and text', () => {
    expect(parseTrainingStatus(dataView([0x00, 0x01]))).toEqual({ status: 1, text: 'Idle' });
    expect(parseTrainingStatus(dataView([0x00, 0x0d]))).toEqual({ status: 13, text: 'Manual Mode' });
    expect(parseTrainingStatus(dataView([0x00, 0x99]))).toEqual({ status: 0x99, text: '0x99' });
    expect(parseTrainingStatus(dataView([0x00]))).toBeNull();
  });
});

describe('buildTreadmillData', () => {
  it('round trip with the parser', () => {
    const d = { speed: 3.4, dist: 1234, incl: 2, rampAngle: 0, kcal: 45, kcalPerHour: 200, kcalPerMin: 3, hr: 0, time: 321 };
    expect(parseTreadmillData(dataView(buildTreadmillData(d)))).toEqual(d);
  });

  it('without speed, bit 0 is set', () => {
    const bytes = buildTreadmillData({ time: 5 });
    expect(bytes[0]! & 1).toBe(1);
    expect(parseTreadmillData(dataView(bytes))).toEqual({ time: 5 });
  });
});
