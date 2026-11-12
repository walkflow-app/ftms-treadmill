// What the treadmill reports while connected, as far as it concerns driving the belt: the measured speed (for the governor,
// the belt phase and the standstill detection), Machine Status (the treadmill stopped by itself, control lost) and the
// answers to commands (a refused Stop, a refused speed). Everything is handed on to the app as well; this sends nothing.

import { hex, OP, parseMachineStatus, type ControlPointResponse, type MachineEvent, type TreadmillData } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import type { BeltPhaseTracker } from '../safety/belt-phase.ts';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import type { BeltState } from './belt-state.ts';

/** Why the belt stopped without the app asking for it */
export type ReportedEnd = 'machine-stopped' | 'machine-paused' | 'safety-key' | 'standstill';

export interface ReportsHost {
  session: BeltState;
  phase: Pick<BeltPhaseTracker, 'stopRequested' | 'speed'>;
  governor: Pick<SpeedGovernor, 'reset' | 'noteMeasured' | 'commandRefused'>;
  standstill: Pick<StandstillDetector, 'disarm' | 'feed'>;
  now(): number;
  /** A workout or route runs (the app says so) */
  programActive(): boolean;
  /** The belt stopped by itself or stands still during a program: a running program ends */
  ended(reason: ReportedEnd): void;
  /** true: the treadmill refused a Stop or Pause while the belt moves, so the person has to stop it on the treadmill */
  stopFailed(failed: boolean): void;
  notice(n: Notice): void;
  /** Handed on to the app */
  data(d: TreadmillData): void;
  machineStatus(s: { event: MachineEvent | null; hex: string }): void;
  controlResponse(r: ControlPointResponse): void;
}

/** Control Point result code "Success" */
const RESULT_OK = 1;

const MACHINE_ENDS: Partial<Record<MachineEvent['kind'], ReportedEnd>> = {
  stopped: 'machine-stopped',
  paused: 'machine-paused',
  'safety-key': 'safety-key',
};

export function setupReports(host: ReportsHost) {
  const { session, phase, governor, standstill } = host;

  function data(r: TreadmillData) {
    if (r.speed !== undefined) {
      const now = host.now();
      phase.speed(r.speed, now);
      session.lastMeasured = r.speed;
      session.lastMeasuredAt = now;
      governor.noteMeasured(r.speed);
      if (standstill.feed(r.speed, now) && host.programActive()) {
        host.ended('standstill');
        governor.reset();
      }
    }
    host.data(r);
  }

  function machineStatus(dv: DataView) {
    const e = parseMachineStatus(dv);
    host.machineStatus({ event: e, hex: hex(dv) });
    if (!e) return;
    const end = MACHINE_ENDS[e.kind];
    if (end) {
      phase.stopRequested(host.now());
      session.beltStarted = false;
      host.ended(end);
      governor.reset();
      standstill.disarm();
    } else if (e.kind === 'started') {
      session.beltStarted = true;
    } else if (e.kind === 'control-lost') {
      session.controlLost = true;
    }
  }

  /**
   * A write that went through is not yet a command the treadmill accepted. What it refused must not count as done: a refused
   * Stop on a moving belt is told to the person, a refused speed ends the ramp, refused control is asked for again at the next stop.
   */
  function controlResponse(r: ControlPointResponse) {
    host.controlResponse(r);
    if (r.result === RESULT_OK) return;
    switch (r.requestOp) {
      case OP.STOP_PAUSE:
        // A belt that stands has nothing to stop: some treadmills answer "failed" then
        if ((session.lastMeasured ?? 0) > 0) host.stopFailed(true);
        break;
      case OP.SET_SPEED:
        governor.commandRefused();
        host.notice({ code: 'speed-refused' });
        break;
      case OP.REQUEST_CONTROL:
        session.controlLost = true;
        break;
      default:
        break;
    }
  }

  return { data, machineStatus, controlResponse };
}
