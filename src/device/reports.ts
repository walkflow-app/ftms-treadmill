// What the treadmill reports while connected, as far as it concerns driving the belt: the measured speed (for the governor,
// the belt phase and the standstill detection), Machine Status (the treadmill stopped by itself, control lost) and the
// answers to commands (a refused Stop, a refused speed). Everything is handed on to the app as well; this sends nothing.

import { hex, OP, parseMachineStatus, parseTrainingStatus, type ControlPointResponse, type MachineEvent, type TreadmillData } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import type { BeltPhaseTracker } from '../safety/belt-phase.ts';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import type { BeltState } from './belt-state.ts';

/** Why the belt stopped without the app asking for it */
export type ReportedEnd = 'machine-stopped' | 'machine-paused' | 'safety-key' | 'standstill';

export interface ReportsHost {
  session: BeltState;
  phase: Pick<BeltPhaseTracker, 'stopRequested' | 'speed'>;
  governor: Pick<SpeedGovernor, 'reset' | 'hintStop' | 'noteCountdown' | 'noteCountdownOver' | 'noteMeasured' | 'commandRefused'>;
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
/** Control Point result code "Control Not Permitted" */
const RESULT_CONTROL_NOT_PERMITTED = 5;
/** Training Status "Post-Workout" */
const TRAINING_POST_WORKOUT = 0x0f;
/** Training Status "Pre-Workout": the treadmill's start countdown */
const TRAINING_PRE_WORKOUT = 0x0e;

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
        governor.reset(true);
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
      // Also withdraws a speed command of the ramp that still waits to be written (governor.reset, SpeedGovernor.pump)
      governor.reset(true); // the belt coasts down: nothing is sent until it stands and a new run begins
      standstill.disarm();
    } else if (e.kind === 'started') {
      session.beltStarted = true;
      // No new run for the governor: its wait after a stop ends only on what the belt does (standing, or running steady),
      // never on this message alone, so a held speed is not ramped onto a decelerating belt (#25)
    } else if (e.kind === 'control-lost') {
      session.controlLost = true;
    }
  }

  /**
   * Training Status "Post-Workout" (0x0f) comes about a second after a stop, at the treadmill or sent by the app, and 4 to 8 s
   * before the Machine Status "stopped" (Sportstech sPad 500, #39). It is taken as the hint of a stop: the ramp is forgotten
   * and nothing is sent until the wait after a stop ends, like for that Machine Status. Whether it comes in other cases is
   * not known; a wrong guess only holds the ramp back, and only for HINT_WINDOW_MS if no stop report and no stop sent follows
   * (governor.hintStop), so the belt is never made faster by it. It tells no `ended` and does not change the belt phase:
   * those wait for the Machine Status, which is the report of a stop.
   */
  function trainingStatus(dv: DataView) {
    const status = parseTrainingStatus(dv)?.status;
    if (status === TRAINING_POST_WORKOUT) governor.hintStop();
    else if (status === TRAINING_PRE_WORKOUT) governor.noteCountdown();
    else if (status !== undefined) governor.noteCountdownOver();
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
        // Without control a Stop is refused: the next attempt asks for control first
        if (r.result === RESULT_CONTROL_NOT_PERMITTED) session.controlLost = true;
        // A belt that stands has nothing to stop: some treadmills answer "failed" then. With no reading yet, a belt that was
        // started (or was when the Stop was sent: the answer comes after the write) counts as running: when in doubt it is
        if (session.lastMeasured === undefined ? session.beltStarted || session.stopSentWhileRunning : session.lastMeasured > 0) host.stopFailed(true);
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

  return { data, machineStatus, trainingStatus, controlResponse };
}
