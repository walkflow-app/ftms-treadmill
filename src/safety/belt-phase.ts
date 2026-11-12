// What the belt is doing: starting (a Start was sent and the treadmill counts down), running, stopping (a stop was asked for
// and the belt still moves), standing, or not known. Facts only; how the app shows them (the banner's colours and fading) is
// the app's business. The Start button stays locked while the belt is starting (controlAvailability). No DOM.

/** The treadmill counts down before it moves: a start counts as under way for at most this long */
export const START_MS = 4500;
/** A measured speed from which the belt counts as moving */
export const MOVING_KMH = 0.3;
/** Below this the belt counts as standing */
export const STANDING_KMH = 0.1;
/** A stop that is not confirmed by the speed (nothing reported) is dropped after this */
export const STOP_MAX_MS = 20_000;

export type BeltPhase = 'unknown' | 'standing' | 'starting' | 'running' | 'stopping';

export class BeltPhaseTracker {
  private isConnected = false;
  private speedNow: number | undefined;
  private startAt: number | null = null;
  private stopAt: number | null = null;

  setConnected(connected: boolean): void {
    this.isConnected = connected;
    this.startAt = null;
    this.stopAt = null;
    this.speedNow = undefined;
  }

  /** A start was sent: the treadmill counts down now */
  startRequested(nowMs: number): void {
    this.stopAt = null;
    this.startAt = nowMs;
  }

  /** A stop or pause was sent, or the treadmill says it stopped. Nothing to wait for if the belt does not move. */
  stopRequested(nowMs: number): void {
    if (this.stopAt !== null) return;
    this.startAt = null;
    const v = this.speedNow;
    if (v === undefined || v < STANDING_KMH) return;
    this.stopAt = nowMs;
  }

  /** The measured speed of the belt in km/h */
  speed(kmh: number, _nowMs: number): void {
    this.speedNow = kmh;
    if (this.startAt !== null && kmh >= MOVING_KMH) this.startAt = null;
    if (this.stopAt !== null && kmh < STANDING_KMH) this.stopAt = null;
  }

  phase(nowMs: number): BeltPhase {
    if (!this.isConnected) return 'unknown';
    if (this.startAt !== null) {
      if (nowMs - this.startAt < START_MS) return 'starting';
      this.startAt = null;
    }
    if (this.stopAt !== null) {
      if (nowMs - this.stopAt < STOP_MAX_MS) return 'stopping';
      this.stopAt = null;
    }
    const v = this.speedNow;
    if (v === undefined) return 'unknown';
    return v < STANDING_KMH ? 'standing' : 'running';
  }
}
