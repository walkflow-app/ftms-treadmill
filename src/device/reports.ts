// What the treadmill reports while connected, as far as it concerns driving the belt: the measured speed (for the governor,
// the belt phase and the standstill detection), Machine Status (the treadmill stopped by itself, control lost) and the
// answers to commands (a refused Stop, a refused speed). Everything is handed on to the app as well; this sends nothing.

import { hex, OP, parseMachineStatus, type ControlPointResponse, type MachineEvent, type TreadmillData } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import { MOVING_KMH, type BeltPhaseTracker } from '../safety/belt-phase.ts';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import type { BeltState } from './belt-state.ts';

/** Why the belt stopped without the app asking for it */
export type ReportedEnd = 'machine-stopped' | 'machine-paused' | 'safety-key' | 'standstill';

export interface ReportsHost {
  session: BeltState;
  phase: Pick<BeltPhaseTracker, 'stopRequested' | 'speed'>;
  governor: Pick<SpeedGovernor, 'reset' | 'noteMeasured' | 'commandRefused' | 'afterStop' | 'stops' | 'newRun'>;
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

/** A Training Status hint of a stop that no Machine Status stop followed in this long (a real one comes within 4 to 8 s) is dropped */
const HINT_WINDOW_MS = 15_000;

/** Control Point result code "Success" */
const RESULT_OK = 1;
/** Control Point result code "Control Not Permitted" */
const RESULT_CONTROL_NOT_PERMITTED = 5;

const MACHINE_ENDS: Partial<Record<MachineEvent['kind'], ReportedEnd>> = {
  stopped: 'machine-stopped',
  paused: 'machine-paused',
  'safety-key': 'safety-key',
};

export function setupReports(host: ReportsHost) {
  const { session, phase, governor, standstill } = host;
  /** The hold a Training Status hint started (when, and the governor's stop count right after it) */
  let hint: { at: number; stops: number } | null = null;

  function data(r: TreadmillData) {
    if (r.speed !== undefined) {
      const now = host.now();
      phase.speed(r.speed, now);
      session.lastMeasured = r.speed;
      session.lastMeasuredAt = now;
      governor.noteMeasured(r.speed);
      hintExpired(r.speed, now);
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
   * The treadmill reports Training Status "Post-Workout" (0x0f): seen 1 s after every stop, sent by the app or pressed on the
   * treadmill, and 4 to 8 s before the Machine Status "stopped" of a stop at the treadmill (#39). It is taken as a hint of a
   * stop: the ramp is forgotten and nothing is sent, like after a stop (the same wait, ended by the same evidence or a new run).
   * Fail-safe: whatever else 0x0f means, a wrong guess only holds a speed back. A wait that already runs is left alone, so
   * the echo of a stop the app sent does not count as a second stop (it would overtake a Start being sent).
   */
  function stopHint() {
    if (governor.afterStop) return;
    governor.reset(true);
    hint ={ at: host.now(), stops: governor.stops };
  }

  /**
   * A hint no stop followed ends its own hold: the Machine Status of a real stop comes within 4 to 8 s, and a belt still
   * running steadily after HINT_WINDOW_MS means the hint was something else. Only the hold the hint started ends: any stop
   * since (sent by the app, or reported) is a real one and keeps its own wait.
   */
  function hintExpired(speed: number, now: number) {
    if (!hint) return;
    if (!governor.afterStop || governor.stops !== hint.stops) { hint = null; return; }
    if (now - hint.at >= HINT_WINDOW_MS && speed >= MOVING_KMH) { hint = null; governor.newRun(); }
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

  return { data, machineStatus, controlResponse, stopHint };
}
