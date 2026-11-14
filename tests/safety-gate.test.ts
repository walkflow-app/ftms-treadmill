import { describe, expect, it } from 'vitest';
// @ts-expect-error plain script without types, also run by node in CI
import { checkSafetyGate } from '../scripts/safety-gate.mjs';

interface Result { errors: string[]; warnings: string[] }
const gate = (files: string[], title = 'fix: something'): Result => checkSafetyGate({ files, title });

describe('safety gate (a pull request that changes what is sent to the treadmill)', () => {
  it('lets a change without safety code pass', () => {
    expect(gate(['docs/API.md', 'src/sim.ts'])).toEqual({ errors: [], warnings: [] });
  });

  it('fails a change to safety code without a changed test', () => {
    for (const f of ['src/safety/safety.ts', 'src/device/belt-commands.ts', 'src/device/treadmill.ts', 'src/protocol/control.ts']) {
      const r = gate([f], 'safety: x');
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain(f);
    }
  });

  it('passes with a changed test, and reminds of the treadmill checks', () => {
    const r = gate(['src/safety/safety.ts', 'src/safety/safety.test.ts'], 'safety(limit): x');
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('HARDWARE-TESTS.md');
  });

  it('warns when safety code changes under a title that is not safety', () => {
    const r = gate(['src/device/ble.ts', 'src/device/ble.test.ts'], 'refactor: rename');
    expect(r.errors).toEqual([]);
    expect(r.warnings.some(w => w.includes('"safety'))).toBe(true);
  });

  it('does not count a test file alone, or the simulator, as safety code', () => {
    expect(gate(['src/device/sim.ts', 'src/safety/safety.test.ts'])).toEqual({ errors: [], warnings: [] });
  });
});
