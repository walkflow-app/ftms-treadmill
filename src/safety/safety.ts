// Safety logic: limits, ramps, checking console commands, estimating the belt state.
// Pure logic without DOM/BLE, fully tested (safety.test.ts). Do not weaken.

import { decodeSetSpeed, OP } from '../protocol/ftms.ts';
import type { ConsoleBlock, Notice } from '../protocol/notice.ts';

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
  /** Sends Set Speed. false = write error. */
  send(kmh: number): Promise<boolean>;
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
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;
  private gen = 0;
  /** null: not known yet (nothing measured, no reset), which holds nothing */
  private moving: boolean | null = null;
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

  noteMeasured(kmh: number, at = this.deps.now()) {
    this.measured = { kmh, at };
    const was = this.moving;
    this.moving = kmh >= MOVING_KMH;
    if (this.moving && was === false) { this.pump(); this.deps.onChange?.(); }
  }

  /** Speed command sent from outside (console): ends the ramp and counts for the minimum interval. */
  noteExternalCommand(kmh: number) {
    this.cancel();
    this.last = { kmh, at: this.deps.now() };
  }

  /** Planning starts here: the last command while the belt is still settling, otherwise the measured value. */
  base(): number {
    const now = this.deps.now();
    const m = this.measured && now - this.measured.at < this.opts.freshMs ? this.measured.kmh : undefined;
    const l = this.last;
    if (!l) return m ?? this.range.min;
    if (now - l.at < this.opts.settleMs) return l.kmh;
    if (m !== undefined && Math.abs(m - l.kmh) > this.maxStep + EPS) return m;
    return l.kmh;
  }

  setRange(range: SpeedRange) {
    this.range = { ...range };
    if (this._target !== null) {
      this._target = clampSpeed(this._target, range);
      if (this._target === null) { this.cancel(); return; }
    }
    // If the belt runs above a limit that was just lowered, actively regulate down to the limit
    if ((this.last || this.measured) && this.base() > range.max + EPS) this.request(range.max);
    else this.pump();
  }

  request(kmh: number): number | null {
    const clamped = clampSpeed(kmh, this.range);
    if (clamped === null) {
      this.deps.notice?.({ code: 'no-allowed-speed', min: this.range.min, max: this.range.max });
      return null;
    }
    this._target = clamped;
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
    if (!ok && this.last === mine) this.last = null;
    return ok;
  }

  /** End the ramp immediately (stop, pause, disconnect). */
  cancel() {
    this.gen++;
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

  /** Additionally forget the last command and measured value (after stop, start, disconnect). */
  reset() {
    this.cancel();
    this.last = null;
    this.measured = null;
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
    let plan = planRamp(this.base(), target, this.maxStep, this.range);
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
    void this.deps.send(next).catch(() => false).then(ok => {
      this.sending = false;
      // The belt never got this speed: the next ramp starts from the one it got before
      if (!ok && this.last === mine) this.last = before;
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

export function checkConsoleCommand(bytes: number[], ctx: ConsoleContext): ConsoleCheck {
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
  const moving = s.measuredKmh !== undefined && s.measuredKmh >= MOVING_KMH && s.measuredAgeMs <= READING_FRESH_MS;
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
