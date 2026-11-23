// The commands that start, pause and stop the belt, and what has to happen around each of them: a running program is told
// to end, the governor forgets its ramp, the standstill detection is switched off, the belt phase and state follow.
// No DOM here on purpose, so the order of these steps can be tested. Stop and Pause go out urgently, ahead of anything queued,
// they end a start that is still being sent, and they are sent again if the treadmill did not take them.

import { cmdPause, cmdRequestControl, cmdStart, cmdStop } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import type { BeltPhaseTracker } from '../safety/belt-phase.ts';
import { beltMeasuredMoving, type SpeedGovernor, type StandstillDetector } from '../safety/safety.ts';
import type { BeltState } from './belt-state.ts';

/** How often a Stop or Pause is sent before the app says that it could not stop the belt */
export const STOP_ATTEMPTS = 3;
/** The wait before it is sent again */
export const STOP_RETRY_MS = 300;
/** Control Point result code "Success" */
const RESULT_OK = 1;

export interface BeltHost {
  session: BeltState;
  phase: Pick<BeltPhaseTracker, 'startRequested' | 'stopRequested'>;
  governor: SpeedGovernor;
  standstill: StandstillDetector;
  now(): number;
  /** The last speed asked for, also before a stop or pause: Start ramps up to it again (null: none yet) */
  wanted(): number | null;
  /** The belt is stopped or paused on purpose: a running workout or route ends */
  ended(reason: 'stop' | 'pause' | 'console'): void;
  notice(n: Notice): void;
  /** Resolves after this many milliseconds (between two attempts to stop) */
  wait(ms: number): Promise<void>;
  /**
   * true: a Stop or Pause could not be sent although the treadmill is connected, so the person has to stop the belt on the
   * treadmill. false: a Stop or Pause went through, the warning can go.
   */
  stopFailed(failed: boolean): void;
  /**
   * Starts listening for the treadmill's answer to the next Set Speed (call it before the command is written: an answer can
   * come before the write returns). wait resolves with the result code, or null if none came in time; drop stops listening.
   */
  expectSpeedAnswer(): { wait(): Promise<number | null>; drop(): void };
}

export function setupBelt(host: BeltHost) {
  const { session, phase, governor, standstill } = host;
  /** Counts every start, stop and pause: whoever finds a higher number after waiting has been overtaken and gives up */
  let epoch = 0;
  /** Stops and Pauses being sent or sent again: a Start does not take over from them (it would end their attempts) */
  let stopping = 0;

  /** The belt stops (or pauses) on purpose: nothing may keep it going, and standing still is expected from now on */
  function leaveRunning(reason: 'stop' | 'pause' | 'console') {
    epoch++;
    phase.stopRequested(host.now());
    host.ended(reason);
    governor.reset();
    standstill.disarm();
  }

  /**
   * Sends Stop or Pause urgently, and again if it did not go through. It gives up when a newer command has taken over (that one
   * does its own sending) or the connection is gone (the connection alarm says so); if every attempt fails, the person is told.
   */
  async function sendStop(bytes: Uint8Array): Promise<boolean> {
    const c = session.client;
    if (!c) return false;
    const mine = epoch;
    stopping++;
    try {
      for (let attempt = 1; ; attempt++) {
        // Control may have been lost before, or the treadmill just refused this Stop for it: ask again before every attempt
        if (session.controlLost) void c.send(cmdRequestControl(), { urgent: true });
        if (await c.send(bytes, { urgent: true })) {
          session.stopSentWhileRunning = session.maybeRunning();
          session.beltStarted = false;
          host.stopFailed(false);
          return true;
        }
        if (epoch !== mine || session.client !== c || !c.connected) return false;
        // The first failure already tells the person: the belt may be moving, and the retries take seconds
        if (attempt === 1) host.stopFailed(true);
        if (attempt >= STOP_ATTEMPTS) return false;
        await host.wait(STOP_RETRY_MS);
        // A newer stop or pause and a lost connection happen during the wait; TypeScript does not see that
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- changed by other calls while awaiting
        if (epoch !== mine || session.client !== c || !c.connected) return false;
      }
    } finally {
      stopping--;
    }
  }

  function stop(reason: 'stop' | 'console' = 'stop'): Promise<boolean> {
    leaveRunning(reason);
    return sendStop(cmdStop());
  }

  function pause(reason: 'pause' | 'console' = 'pause'): Promise<boolean> {
    leaveRunning(reason);
    return sendStop(cmdPause());
  }

  /**
   * False if it failed, or if a stop or pause came in while it was being sent: then nothing more of it goes out. Start is only
   * sent once the start speed is set and not refused (a treadmill would run up to its last speed, past the ramp), and never on a
   * belt measured moving (a fresh reading, or an older one while the belt counts as started; the start speed would drop the belt to the lowest speed in one step).
   */
  async function start(): Promise<boolean> {
    const c = session.client;
    if (!c) return false;
    // A Stop or Pause is still being sent (or sent again): it keeps its attempts, a Start would end them
    if (stopping > 0) return false;
    // Nothing is touched: the belt runs on, and so does a ramp that may be going. An old reading counts only while the belt is
    // known to have been started and not stopped since: a treadmill that stops reporting at a standstill must not lock Start
    // (the same rule as controls.start, so the app never offers a Start that does nothing)
    if (beltMeasuredMoving({ measuredKmh: session.lastMeasured, measuredAgeMs: host.now() - session.lastMeasuredAt, startedByApp: session.beltStarted })) {
      host.notice({ code: 'start-belt-moving' });
      return false;
    }
    const mine = ++epoch;
    // The speed asked for last (before the stop, or chosen while the belt stood) is asked for again once Start went out; the
    // governor holds it until the belt moves and then ramps up from the start speed
    const chosen = governor.target ?? host.wanted();
    governor.reset();
    standstill.disarm();
    const a = await c.send(cmdRequestControl());
    if (epoch !== mine) return false;
    if (a) session.controlLost = false;
    // A treadmill runs up to the speed it last had after Start, so the ramp would be skipped: take that speed away first
    const answer = host.expectSpeedAnswer();
    const speedSet = await governor.startSpeed();
    if (epoch !== mine) { answer.drop(); return false; }
    if (!speedSet) {
      answer.drop();
      host.notice({ code: 'start-speed-failed' });
      return false;
    }
    // A write that went through is not yet a speed the treadmill took; one that gives no answer in time is let through
    const result = await answer.wait();
    if (epoch !== mine) return false;
    if (result !== null && result !== RESULT_OK) {
      host.notice({ code: 'start-speed-failed' });
      return false;
    }
    const b = await c.send(cmdStart());
    // A stop that came in while Start was on its way was sent after it, and the belt is its business now
    if (epoch !== mine) return false;
    if (b) {
      session.beltStarted = true;
      session.stopSentWhileRunning = false;
      phase.startRequested(host.now());
      if (chosen !== null) governor.request(chosen);
    }
    return a && b;
  }

  return { start, stop, pause };
}
