// Safety logic: limits, ramps, checking console commands, estimating the belt state.
// Pure logic without DOM/BLE, fully tested (safety.test.ts). Do not weaken.

import { decodeSetSpeed, OP } from '../protocol/ftms.ts';
import type { ConsoleBlock, Notice } from '../protocol/notice.ts';
import { STANDING_KMH } from './belt-phase.ts';

const EPS = 1e-9;

// ---------- Limit ----------

export const DEFAULT_SPEED_LIMIT = 6;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 20;
/** Limits above this value only with an extra confirmation. */
export const LIMIT_CONFIRM_ABOVE = 6;

export interface SpeedRange {
  min: number;
  max: number;
}

// ---------- Clamping ----------

const floor01 = (x: number) => Math.floor(x * 10 + EPS) / 10;
const ceil01 = (x: number) => Math.ceil(x * 10 - EPS) / 10;

/**
 * Clamps to [min, max] and rounds to 0.1 km/h without leaving the bounds.
 * If there is no allowed value (e.g. limit below the device minimum), returns null
 * instead of silently sending the minimum.
 */
export function clampSpeed(kmh: number, range: SpeedRange): number | null {
  if (!Number.isFinite(kmh) || range.max < range.min) return null;
  let v = Math.round(Math.max(range.min, Math.min(range.max, kmh)) * 10) / 10;
  if (v > range.max) v = floor01(range.max);
  if (v < range.min) v = ceil01(range.min);
  return v > range.max + EPS || v < range.min - EPS ? null : v;
}

// ---------- Ramp ----------

export const DEFAULT_MAX_STEP = 0.5;
export const MAX_STEP_MIN = 0.1;
export const MAX_STEP_MAX = 1;
/** Minimum interval between two speed commands */
export const RAMP_INTERVAL_MS = 1500;
/**
 * Intermediate targets from `from` to `to`. Each step changes by at most `maxStep`, all values are within the range.
 * Only exception to maxStep: if `from` is outside the range (e.g. 0 = belt stopped, or above a limit that was
 * just lowered), the first step goes straight to the range boundary. Nothing is ever commanded above the limit.
 */
export function planRamp(from: number, to: number, maxStep: number, range: SpeedRange): number[] {
  const target = clampSpeed(to, range);
  if (target === null || !Number.isFinite(from) || !(maxStep > 0)) return [];
  const steps: number[] = [];
  let prev = from;
  for (let guard = 0; guard < 2000; guard++) {
    const diff = target - prev;
    if (Math.abs(diff) < EPS) break;
    let next = Math.abs(diff) <= maxStep + EPS ? target : diff > 0 ? floor01(prev + maxStep) : ceil01(prev - maxStep);
    next = Math.min(range.max, Math.max(range.min, next));
    if (diff > 0 && next > target) next = target;
    if (diff < 0 && next < target) next = target;
    if (Math.abs(next - prev) < EPS) break;
    steps.push(next);
    prev = next;
  }
  return steps;
}

export interface GovernorDeps {
  /**
   * Sends Set Speed. false = write error. `current`, for a ramp step: asked when the write's turn comes; false = the ramp
   * was ended meanwhile (stop, reset) or the step is above a limit lowered meanwhile; the step is not written.
   */
  send(kmh: number, current?: () => boolean): Promise<boolean>;
  now(): number;
  /** What the governor did not do, or does later, as a code */
  notice?(n: Notice): void;
  /** Target, last command or ramp state changed. */
  onChange?(): void;
}

export interface GovernorOptions {
  intervalMs: number;
  /** For this long after a command, the command is the base, not the measured value. */
  settleMs: number;
  /** For this long a measured value counts as current. */
  freshMs: number;
}

/** A measured speed from which the belt counts as moving (km/h) */
const MOVING_KMH = 0.3;

/**
 * A reading that differs from the last command by more than maxStep counts only once a second reading, at least this long
 * after the first, agrees with it: one wrong reading (a treadmill that sends 0xFFFF = 655.35 km/h) must not become a step.
 */
const CONFIRM_MS = 1000;

/**
 * The only place that creates speed commands. Approaches every target in steps of at most maxStep,
 * with at least intervalMs between two commands, and never beyond the range.
 *
 * While the belt stands, a target is held and nothing is sent: a treadmill remembers a speed set while standing and runs up
 * to it by itself after Start (a sPad 500 does), past the ramp. Once the belt is seen moving, the held target is approached
 * in steps like any other. After reset (stop, start, new connection) the belt counts as standing until it is seen moving.
 */
export class SpeedGovernor {
  maxStep = DEFAULT_MAX_STEP;
  private range: SpeedRange = { min: 1, max: DEFAULT_SPEED_LIMIT };
  private _target: number | null = null;
  private last: { kmh: number; at: number } | null = null;
  private measured: { kmh: number; at: number } | null = null;
  /** The reading a possible confirmation starts from, and the latest speed that two readings agreed on */
  private anchor: { kmh: number; at: number } | null = null;
  private confirmed: { kmh: number; at: number } | null = null;
  /** The limit was lowered while the belt may run above it, not confirmed yet */
  private limitPending = false;
  private over: { first: number; last: number; kmh: number } | null = null;
  /** The limit, to be sent in one command: the belt was shown to run above it (a command down, never a step up) */
  private lowering: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private gen = 0;
  /** null: not known yet (nothing measured, no reset), which holds nothing */
  private moving: boolean | null = null;
  /** A stop was sent or reported and the belt was not seen standing since: nothing is sent, however fast it still reports */
  private coasting = false;
  /** While coasting: when the readings below STANDING_KMH began (none above it since); null: the last reading was above */
  private standingSince: number | null = null;
  private loggedHeld: number | null = null;
  private readonly opts: GovernorOptions;

  constructor(private readonly deps: GovernorDeps, opts: Partial<GovernorOptions> = {}) {
    this.opts = { intervalMs: RAMP_INTERVAL_MS, settleMs: 5000, freshMs: 3000, ...opts };
  }

  /** Requested target (after clamping), null = none */
  get target() { return this._target; }
  get lastCommand() { return this.last ? { ...this.last } : null; }
  get ramping() { return this.timer !== null || this.sending; }
  /** A target waits for the belt to move */
  get holding() { return this.moving === false && this._target !== null; }
  get currentRange(): SpeedRange { return { ...this.range }; }

  msSinceLastCommand(): number {
    return this.last ? this.deps.now() - this.last.at : Number.POSITIVE_INFINITY;
  }

  /*
   * State of noteMeasured/setRange (what sets it, what clears it):
   * - anchor: first reading of a possible confirmation. Set by a plausible reading that does not agree with it; cleared by an
   *   implausible reading and reset().
   * - confirmed: the lower of two readings that agree, at least CONFIRM_MS apart: the only base above the last command.
   *   Cleared by a plausible reading more than maxStep away from it, and reset().
   * - limitPending: the limit was lowered below a belt that may run above it, not confirmed. Set by setRange; cleared by
   *   setRange, noteExternalCommand (only a console speed below the limit that differs from the last command), reset(), and when the lowered limit is sent or a reading is not above the limit.
   * - over: the readings above a pending limit (first, last, value), two that agree within maxStep confirm it. Cleared with
   *   limitPending, and by a reading not above the limit.
   * - lowering: the limit to be sent in one command, once the belt is shown above it. Cleared by a reading at or below it,
   *   cancel(), reset(), setRange() and when the command was planned.
   */
  noteMeasured(kmh: number, at = this.deps.now()) {
    this.measured = { kmh, at };
    if (!Number.isFinite(kmh) || kmh < 0 || kmh > LIMIT_MAX) {
      this.anchor = null; // not a speed a belt has: it does not even tell whether the belt moves
      return;
    }
    // A newer reading that is somewhere else than what was confirmed: the belt has moved on, the confirmation is stale
    if (this.confirmed && Math.abs(kmh - this.confirmed.kmh) > this.maxStep + EPS) this.confirmed = null;
    // The lowered limit in one command is only a command down while the belt runs above it; once it does not, the limit is
    // approached in steps like any target
    if (this.lowering !== null && kmh <= this.lowering + EPS) this.lowering = null;
    let confirmedNow = false;
    // The anchor stays where a confirmation started: a belt that drifts more than maxStep away from it starts a new anchor
    if (this.anchor && Math.abs(kmh - this.anchor.kmh) <= this.maxStep + EPS && at - this.anchor.at <= this.opts.freshMs) {
      // The lower of the two agreeing readings: one outlier up to maxStep above the other must not become the base
      if (at - this.anchor.at >= CONFIRM_MS) { this.confirmed = { kmh: Math.min(kmh, this.anchor.kmh), at }; confirmedNow = true; }
    } else {
      this.anchor = { kmh, at };
    }
    // A limit lowered below a belt that runs faster: two readings above it, 1 s apart, show that, however they jitter.
    // These readings only serve the lowered limit (a command down); they are never `confirmed`, the base of a step up.
    let overConfirmed = false;
    if (this.limitPending) {
      if (!this.aboveLimit(kmh)) this.over = null;
      else if (!this.over || at - this.over.last > this.opts.freshMs || Math.abs(kmh - this.over.kmh) > this.maxStep + EPS) {
        this.over = { first: at, last: at, kmh }; // the two readings must agree within maxStep, like a confirmation
      }
      else {
        this.over.last = at;
        if (at - this.over.first >= CONFIRM_MS) overConfirmed = true;
      }
    }
    // After a stop the belt decelerates through readings above MOVING_KMH: that is no new run. Only a belt that was seen
    // standing ends the wait; from then on a belt that moves is a new run (a Start, or a belt started on the treadmill).
    // Standing is confirmed like a speed: readings below STANDING_KMH at least CONFIRM_MS apart with none above in between,
    // so one spurious 0.0 during the coast-down (#49) does not end the wait
    if (this.coasting) {
      if (kmh >= STANDING_KMH) this.standingSince = null;
      else if (this.standingSince === null) this.standingSince = at;
      else if (at - this.standingSince >= CONFIRM_MS) { this.coasting = false; this.standingSince = null; }
    }
    const was = this.moving;
    this.moving = !this.coasting && kmh >= MOVING_KMH;
    if (this.moving && was === false) { this.pump(); this.deps.onChange?.(); }
    // A limit was lowered while a reading above it was not yet confirmed: apply it as soon as the belt is shown to run above it
    if ((confirmedNow || overConfirmed) && this.limitPending) {
      if (!this.aboveLimit(kmh)) this.limitPending = false;
      else if (overConfirmed || this.heldBase() > this.range.max + EPS) {
        this.limitPending = false;
        this.lowering = clampSpeed(this.range.max, this.range);
        // This command can be more than maxStep above the last command, but it is a command down for a belt confirmed above
        // the limit, so it falls under the exception of promise 2
        this.request(this.range.max);
      }
    }
  }

  /** Speed command sent from outside (console): ends the ramp and counts for the minimum interval. */
  noteExternalCommand(kmh: number) {
    this.cancel();
    // A console Set Speed that changes the speed to one below the lowered limit already brings the belt under it: a pending
    // lowered limit must not override it later with a step up. A command that repeats the last speed (or is not below the
    // limit) changes nothing about the belt, so the pending limit stays.
    if (this.limitPending && kmh < this.range.max - EPS && (!this.last || Math.abs(kmh - this.last.kmh) > EPS)) {
      this.limitPending = false;
      this.over = null;
    }
    this.last = { kmh, at: this.deps.now() };
  }

  /**
   * Planning starts here: the last command while the belt is still settling. After that the speed two readings agree on, if it
   * differs from the last command by more than maxStep (changed on the treadmill itself), else the last command. A reading
   * that is on its own, or no speed at all, never lifts the base: the next command is at most maxStep above the last one.
   */
  base(): number {
    const b = this.heldBase();
    const l = this.last;
    const now = this.deps.now();
    const m = this.measured;
    // A belt slower than the last command lowers the base at once, one reading is enough.
    // Known: it can also be a spurious low reading (0.0), and that becomes the base too, so a belt at 8 with target 8.5
    // gets range.min in one command (as on main). Open: ftms-treadmill issue #49 (point A).
    if (l && m && now - l.at >= this.opts.settleMs && now - m.at < this.opts.freshMs
      && Number.isFinite(m.kmh) && m.kmh >= 0 && m.kmh <= LIMIT_MAX && m.kmh < b) return m.kmh;
    return b;
  }

  /** The base that only a confirmed reading can lift above the last command (used where a lower base must not hide a limit) */
  private heldBase(): number {
    const now = this.deps.now();
    const fresh = (r: { kmh: number; at: number } | null) => r && now - r.at < this.opts.freshMs ? r.kmh : undefined;
    const l = this.last;
    if (!l) {
      const m = fresh(this.measured);
      return m !== undefined && m >= 0 && m <= LIMIT_MAX ? m : this.range.min;
    }
    if (now - l.at < this.opts.settleMs) return l.kmh;
    const c = fresh(this.confirmed);
    if (c !== undefined && Math.abs(c - l.kmh) > this.maxStep + EPS) return c;
    return l.kmh;
  }

  /**
   * A plausible reading shows the belt above the limit only if it is also more than maxStep away from the last command (the
   * rule of base()): a belt that follows the last command and reads a little above the limit needs no command down.
   */
  private aboveLimit(kmh: number): boolean {
    return kmh > this.range.max + EPS && kmh <= LIMIT_MAX && (!this.last || kmh > this.last.kmh + this.maxStep + EPS);
  }

  /** What a lowered limit asks for: the target if it is below the limit (never faster than the user asked), else the limit */
  private limitGoal(): number {
    return this._target !== null ? Math.min(this._target, this.range.max) : this.range.max;
  }

  setRange(range: SpeedRange) {
    this.range = { ...range };
    if (this._target !== null) {
      this._target = clampSpeed(this._target, range);
      if (this._target === null) { this.cancel(); return; }
    }
    // If the belt runs above a limit that was just lowered, actively regulate down to the limit
    this.limitPending = false;
    this.over = null;
    this.lowering = null;
    const m = this.measured;
    const above = m !== null && this.deps.now() - m.at < this.opts.freshMs && this.aboveLimit(m.kmh);
    // The base is above the limit (confirmed, or the last command): planRamp clamps its first step to range.max, so the limit
    // goes out in one command
    if ((this.last || this.measured) && this.heldBase() > range.max + EPS) this.request(range.max);
    // The belt may run above the new limit, not confirmed yet: the limit is sent at once if that is no step up of more than
    // maxStep from the last command (it can only slow the belt down); a bigger step up waits for two readings (limitPending).
    // So this branch may act on one reading: the command is within maxStep of the last command and below the belt.
    // One reading may be wrong: it must not make the belt faster than the user's target (limitGoal), only slower or equal.
    else if (above && this.last && this.last.kmh + this.maxStep + EPS >= range.max) this.request(this.limitGoal());
    else {
      this.limitPending = above;
      if (above) this.over = { first: m.at, last: m.at, kmh: m.kmh };
      this.pump();
    }
  }

  request(kmh: number): number | null {
    const clamped = clampSpeed(kmh, this.range);
    if (clamped === null) {
      this.deps.notice?.({ code: 'no-allowed-speed', min: this.range.min, max: this.range.max });
      return null;
    }
    this._target = clamped;
    if (this.lowering !== clamped) this.lowering = null;
    if (this.moving === false && this.loggedHeld !== clamped) {
      this.loggedHeld = clamped;
      this.deps.notice?.({ code: 'speed-held-until-moving', kmh: clamped });
    }
    this.pump();
    this.deps.onChange?.();
    return clamped;
  }

  /**
   * The speed the belt starts at: the lowest the device allows, set before Start. A treadmill runs up to the speed it last
   * had by itself after Start (a sPad 500 does), which would skip the ramp; this takes the old value away. It ends a ramp that
   * was running; the next request ramps on from here. False if the device did not take it or the limit leaves no speed.
   */
  async startSpeed(): Promise<boolean> {
    const kmh = clampSpeed(this.range.min, this.range);
    if (kmh === null) {
      this.deps.notice?.({ code: 'no-allowed-speed', min: this.range.min, max: this.range.max });
      return false;
    }
    this.cancel();
    const mine = { kmh, at: this.deps.now() };
    this.last = mine;
    const ok = await this.deps.send(kmh).catch(() => false);
    if (ok && this.last === mine) mine.at = this.deps.now();
    if (!ok && this.last === mine) this.last = null;
    return ok;
  }

  /** End the ramp immediately (stop, pause, disconnect). */
  cancel() {
    this.gen++;
    this.lowering = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this._target = null;
    this.loggedHeld = null;
    this.deps.onChange?.();
  }

  /**
   * The treadmill answered that it did not accept the last speed command: the ramp ends and the command is forgotten, so the
   * next request starts from what the belt really does (the measured speed).
   */
  commandRefused() {
    this.cancel();
    this.last = null;
  }

  /** A new run begins (Start, a Machine Status "started"): the belt is no longer waited for to stand. */
  newRun() {
    this.coasting = false;
    this.standingSince = null;
  }

  /**
   * The treadmill reports Machine Status "started". While the belt coasts down after a stop this is a new run only once
   * standing is confirmed (readings below STANDING_KMH, the first at least CONFIRM_MS ago, none above since): a late or
   * mistaken "started" while the belt still reports a speed, after one spurious 0.0 (#49), or before anything was measured
   * does not end the wait (#25). A treadmill that goes silent at a standstill is confirmed by the time since its first
   * reading below STANDING_KMH; one that reported none since the stop keeps the wait until a new run begins (fail-safe).
   * Accepted window: one spurious 0.0, then no reading for CONFIRM_MS or more (a gap of the connection), then a late
   * "started" ends the wait although the belt may still coast down; a reading in the gap would have prevented it. It needs
   * three faults at once and is checked on a treadmill (does a reading below 0.1 come before "started"?).
   */
  startedReported() {
    if (!this.coasting) return;
    if (this.standingSince !== null && this.deps.now() - this.standingSince >= CONFIRM_MS) this.newRun();
  }

  /**
   * Additionally forget the last command and measured value (after stop, start, disconnect).
   * `afterStop`: the belt may still coast down; nothing is sent until it was seen standing (readings below STANDING_KMH
   * at least CONFIRM_MS apart, none above in between) or a new run begins (reset without afterStop, newRun).
   */
  reset(afterStop = false) {
    this.coasting = afterStop;
    this.standingSince = null;
    this.cancel();
    this.last = null;
    this.measured = null;
    this.anchor = null;
    this.confirmed = null;
    this.limitPending = false;
    this.over = null;
    this.moving = false;
  }

  private pump() {
    if (this.sending || this.timer !== null || this._target === null || this.moving === false) return;
    const now = this.deps.now();
    const wait = this.last ? this.last.at + this.opts.intervalMs - now : 0;
    if (wait > 0) {
      this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
      return;
    }
    const target = this._target;
    let plan = this.lowering === target && this.last?.kmh !== target ? [target] : planRamp(this.base(), target, this.maxStep, this.range);
    this.lowering = null;
    if (!plan.length) {
      if (this.last?.kmh === target) { this.deps.onChange?.(); return; }
      plan = [target]; // base is already the target; the device still gets it explicitly
    }
    const next = plan[0]!;
    const gen = this.gen;
    this.sending = true;
    const before = this.last;
    const mine = { kmh: next, at: now };
    this.last = mine;
    this.deps.onChange?.();
    // The step's turn in the write queue may come after the limit was lowered: a step above the limit then is withdrawn
    let withdrawn = false;
    const current = () => {
      if (gen !== this.gen) return false;
      if (next > this.range.max + EPS) { withdrawn = true; return false; }
      return true;
    };
    void this.deps.send(next, current).catch(() => false).then(ok => {
      this.sending = false;
      // The interval counts from when the write finished: a slow write must not bring two steps to the treadmill together
      if (ok && this.last === mine) mine.at = this.deps.now();
      // The belt never got this speed: the next ramp starts from the one it got before
      if (!ok && this.last === mine) this.last = before;
      // Withdrawn for the lowered limit, not failed: the ramp goes on, planned again against the new limit. If the speed
      // the belt got before already is the target, pump() sends nothing, which is right: the belt has that speed
      if (gen === this.gen && !ok && withdrawn) {
        this.pump();
        this.deps.onChange?.();
        return;
      }
      if (gen === this.gen && !ok) {
        this._target = null;
        this.deps.notice?.({ code: 'ramp-aborted' });
        this.deps.onChange?.();
        return;
      }
      this.pump();
      this.deps.onChange?.();
    });
  }
}

// ---------- Console ----------

/** Strict hex bytes: 1–2 hex digits per byte, separated by spaces or commas. */
export function parseHexBytes(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some(p => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
  return parts.map(p => parseInt(p, 16));
}

export interface ConsoleContext {
  maxKmh: number;
  maxStep: number;
  /** Base of the ramp (last command or measured value) */
  baseKmh: number;
  msSinceLastSpeedCommand: number;
}

export type ConsoleCheck =
  | { action: 'send'; setSpeed?: number }
  | { action: 'block'; reason: ConsoleBlock }
  | { action: 'confirm-start' };

const OP_SET_TARGET_HEART_RATE = 0x06;

/** A byte as it is sent: an integer 0-255. Anything else would change on its way into a Uint8Array, after the check. */
const isByte = (b: number) => Number.isInteger(b) && b >= 0 && b <= 0xff;

/** The longest list sendRaw takes: the most a Control Point write can carry (a BLE attribute is at most 512 bytes) */
const MAX_CONSOLE_BYTES = 512;

/**
 * Copies a list once, before anything is checked, so that what is checked is what goes out (a getter or a Proxy could answer
 * differently on every read). A value that is no array, or too long to copy, comes back as it is: checkConsoleCommand blocks it.
 */
export function snapshotConsoleBytes(bytes: number[]): number[] {
  return Array.isArray(bytes) && bytes.length <= MAX_CONSOLE_BYTES ? Array.from(bytes) : bytes;
}

export function checkConsoleCommand(given: number[], ctx: ConsoleContext): ConsoleCheck {
  // The length is looked at before anything is copied: a list of 2**32-1 holes would hang the main thread, and a Stop with it.
  // Array.from turns a hole into undefined (every would skip it, Uint8Array would send it as 0).
  const bytes = snapshotConsoleBytes(given);
  if (!Array.isArray(bytes) || bytes.length === 0 || bytes.length > MAX_CONSOLE_BYTES || !bytes.every(isByte)) {
    return { action: 'block', reason: { code: 'console-bad-bytes' } };
  }
  const op = bytes[0];
  if (op === OP.SET_SPEED) {
    const kmh = decodeSetSpeed(bytes);
    if (kmh === null || bytes.length !== 3) return { action: 'block', reason: { code: 'console-set-speed-length' } };
    if (kmh > ctx.maxKmh + EPS) return { action: 'block', reason: { code: 'console-over-limit', kmh, max: ctx.maxKmh } };
    if (Math.abs(kmh - ctx.baseKmh) > ctx.maxStep + EPS) {
      return { action: 'block', reason: { code: 'console-jump', from: ctx.baseKmh, to: kmh, maxStep: ctx.maxStep } };
    }
    if (ctx.msSinceLastSpeedCommand < RAMP_INTERVAL_MS) {
      return { action: 'block', reason: { code: 'console-too-soon', intervalMs: RAMP_INTERVAL_MS } };
    }
    return { action: 'send', setSpeed: kmh };
  }
  if (op === OP.START) return { action: 'confirm-start' };
  if (op === OP_SET_TARGET_HEART_RATE) {
    return { action: 'block', reason: { code: 'console-heart-rate' } };
  }
  return { action: 'send' };
}

// ---------- State ----------

/** When in doubt, the belt is running. */
export function beltMaybeRunning(s: { startedByApp: boolean; lastMeasuredKmh: number | undefined }): boolean {
  return s.startedByApp || (s.lastMeasuredKmh ?? 0) > 0;
}

/** A speed reading older than this does not count as known: a treadmill that stops reporting must not lock Start */
const READING_FRESH_MS = 5000;

/**
 * The one rule for "the belt is measured moving", for the Start button and for start() alike: a reading of MOVING_KMH or more
 * that is fresh, or an older one while the belt counts as started by the app (and not stopped since). A treadmill that stops
 * reporting once the belt stands does not lock Start, one that was started by the app and has not been heard of does.
 */
export function beltMeasuredMoving(s: { measuredKmh: number | undefined; measuredAgeMs: number; startedByApp: boolean }): boolean {
  if (s.measuredKmh === undefined || s.measuredKmh < MOVING_KMH) return false;
  return s.startedByApp || s.measuredAgeMs <= READING_FRESH_MS;
}

/**
 * Which of the three control buttons can be pressed. Stop can always be pressed while there is a connection: nothing
 * about the belt's state, however sure the app is, takes it away. Start waits while the belt is known to move, a start
 * was just sent or a program runs (no second start on top of it). Pause is there whenever the belt may be running.
 */
export function controlAvailability(s: {
  connected: boolean;
  measuredKmh: number | undefined;
  /** How long ago the speed was measured */
  measuredAgeMs: number;
  startedByApp: boolean;
  /** A start was sent and the belt has not had time to move yet */
  startingNow: boolean;
  programActive: boolean;
}): { start: boolean; pause: boolean; stop: boolean } {
  if (!s.connected) return { start: false, pause: false, stop: false };
  const moving = beltMeasuredMoving(s);
  return {
    start: !moving && !s.startingNow && !s.programActive,
    pause: beltMaybeRunning({ startedByApp: s.startedByApp, lastMeasuredKmh: s.measuredKmh }) || s.startingNow || s.programActive,
    stop: true,
  };
}

/**
 * Detects that the belt stands still during a program (e.g. stopped with the remote or the safety key),
 * so the program sends no further commands.
 */
export class StandstillDetector {
  private armed = false;
  private zeroSince: number | null = null;

  constructor(private readonly thresholdMs = 8000) {}

  /** Arm. Calling arm() again does not reset a standstill that is already being counted. */
  arm() {
    if (this.armed) return;
    this.armed = true;
    this.zeroSince = null;
  }
  disarm() { this.armed = false; this.zeroSince = null; }

  /** true exactly once, when only 0 km/h has been reported for thresholdMs. */
  feed(kmh: number, now: number): boolean {
    if (!this.armed) return false;
    if (kmh > 0) { this.zeroSince = null; return false; }
    this.zeroSince ??= now;
    if (now - this.zeroSince >= this.thresholdMs) { this.disarm(); return true; }
    return false;
  }
}
