// The commands that start, pause and stop the belt, and what has to happen around each of them: a running program is told
// to end, the governor forgets its ramp, the standstill detection is switched off, the belt phase and state follow.
// No DOM here on purpose, so the order of these steps can be tested. Stop and Pause go out urgently, ahead of anything queued,
// they end a start that is still being sent, and they are sent again if the treadmill did not take them.

import { cmdPause, cmdRequestControl, cmdStart, cmdStop } from '../protocol/ftms.ts';
import type { Notice } from '../protocol/notice.ts';
import type { BeltPhaseTracker } from '../safety/belt-phase.ts';
import type { SpeedGovernor, StandstillDetector } from '../safety/safety.ts';
import type { BeltState } from './belt-state.ts';

/** How often a Stop or Pause is sent before the app says that it could not stop the belt */
export const STOP_ATTEMPTS = 3;
/** The wait before it is sent again */
export const STOP_RETRY_MS = 300;

export interface BeltHost {
  session: BeltState;
  phase: Pick<BeltPhaseTracker, 'startRequested' | 'stopRequested'>;
  governor: SpeedGovernor;
  standstill: StandstillDetector;
  now(): number;
  /** The last speed asked for, also before a stop or pause: Start ramps up to it again (null: none yet) */
  wanted(): number | null;
  /** The belt is stopped or paused on purpose: a running workout or route ends */
  ended(reason: 'stop' | 'pause'): void;
  notice(n: Notice): void;
  /** Resolves after this many milliseconds (between two attempts to stop) */
  wait(ms: number): Promise<void>;
  /**
   * true: a Stop or Pause could not be sent although the treadmill is connected, so the person has to stop the belt on the
   * treadmill. false: a Stop or Pause went through, the warning can go.
   */
  stopFailed(failed: boolean): void;
}

export function setupBelt(host: BeltHost) {
  const { session, phase, governor, standstill } = host;
  /** Counts every start, stop and pause: whoever finds a higher number after waiting has been overtaken and gives up */
  let epoch = 0;

  /** The belt stops (or pauses) on purpose: nothing may keep it going, and standing still is expected from now on */
  function leaveRunning(reason: 'stop' | 'pause') {
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
    if (session.controlLost) void c.send(cmdRequestControl(), { urgent: true });
    for (let attempt = 1; ; attempt++) {
      if (await c.send(bytes, { urgent: true })) {
        session.beltStarted = false;
        host.stopFailed(false);
        return true;
      }
      if (epoch !== mine || session.client !== c || !c.connected) return false;
      if (attempt >= STOP_ATTEMPTS) break;
      await host.wait(STOP_RETRY_MS);
      if (epoch !== mine || session.client !== c || !c.connected) return false;
    }
    host.stopFailed(true);
    return false;
  }

  function stop(): Promise<boolean> {
    leaveRunning('stop');
    return sendStop(cmdStop());
  }

  function pause(): Promise<boolean> {
    leaveRunning('pause');
    return sendStop(cmdPause());
  }

  /** False if it failed, or if a stop or pause came in while it was being sent: then nothing more of it goes out. */
  async function start(): Promise<boolean> {
    const c = session.client;
    if (!c) return false;
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
    const speedSet = await governor.startSpeed();
    if (epoch !== mine) return false;
    if (!speedSet) host.notice({ code: 'start-speed-failed' });
    const b = await c.send(cmdStart());
    // A stop that came in while Start was on its way was sent after it, and the belt is its business now
    if (epoch !== mine) return false;
    if (b) {
      session.beltStarted = true;
      phase.startRequested(host.now());
      if (chosen !== null && chosen !== undefined) governor.request(chosen);
    }
    return a && b;
  }

  return { start, stop, pause };
}
