// The treadmill as one object with a defined API (docs/LIBRARY.md): connect, start, stop, pause, a speed and an incline, the
// limits, and what the treadmill reports. It owns everything that drives the belt (the governor, the standstill detection,
// the belt phase, the order of start and stop), so that the app only draws and asks. The API: docs/API.md.
// No texts and no DOM: what it has to say is a Notice code, the app says it in its language.

import { cmdRequestControl, cmdSetInclination, cmdSetSpeed, hex, OP, parseTrainingStatus, type ControlPointResponse, type MachineEvent, type Range, type TreadmillData } from '../protocol/ftms.ts';
import type { ConsoleBlock, Notice } from '../protocol/notice.ts';
import { BeltPhaseTracker, MOVING_KMH, type BeltPhase } from '../safety/belt-phase.ts';
import { clampIncline, inclineSupport } from '../safety/incline.ts';
import {
  checkConsoleCommand, controlAvailability, DEFAULT_MAX_STEP, DEFAULT_SPEED_LIMIT, LIMIT_CONFIRM_ABOVE, LIMIT_MAX, LIMIT_MIN,
  MAX_STEP_MAX, MAX_STEP_MIN, SpeedGovernor, StandstillDetector,
} from '../safety/safety.ts';
import { TreadmillClient, type BleAdapter, type ConnectResult } from './ble.ts';
import { setupBelt } from './belt-commands.ts';
import { BeltState } from './belt-state.ts';
import { setupReports, type ReportedEnd } from './reports.ts';

export type { BeltPhase } from '../safety/belt-phase.ts';

/** Who asked for a speed: a running workout or route, or the person (buttons, keys, presets) */
export type CommandSource = 'program' | 'manual';

/** Why the belt ended: asked for by the app (stop, pause, a raw stop in the console), or by itself */
export type EndReason = 'stop' | 'pause' | 'console' | ReportedEnd;

/** The time the treadmill uses for its timings; pass a fake one in tests */
export interface Clock {
  /** Milliseconds, monotonic (performance.now() by default) */
  now(): number;
  /** Resolves after ms milliseconds */
  wait(ms: number): Promise<void>;
}

/** Options of createTreadmill */
export interface TreadmillOptions {
  /** The highest speed ever sent, km/h, LIMIT_MIN..LIMIT_MAX (default DEFAULT_SPEED_LIMIT); above LIMIT_CONFIRM_ABOVE only with limitConfirmed */
  speedLimit?: number;
  /** A person confirmed a limit above LIMIT_CONFIRM_ABOVE; belongs to the speedLimit it is given with (default false) */
  limitConfirmed?: boolean;
  /** km/h per command while ramping, MAX_STEP_MIN..MAX_STEP_MAX (default DEFAULT_MAX_STEP) */
  maxStep?: number;
  /** For tests: the time the treadmill uses (default real time) */
  clock?: Clock;
}

/** A snapshot of the treadmill (Treadmill.state) */
export interface TreadmillState {
  /** Connected to a treadmill */
  connected: boolean;
  /** What the belt does */
  belt: BeltPhase;
  /** Which buttons may be used now. Stop is there whenever the treadmill is connected. */
  controls: { start: boolean; pause: boolean; stop: boolean };
  /** When in doubt true */
  maybeRunning: boolean;
  /** The last speed the treadmill reported, km/h */
  lastMeasured: number | undefined;
  /** Where the ramp is going */
  target: number | null;
  /** The last speed sent, and when (clock time) */
  lastCommand: { kmh: number; at: number } | null;
  /** A ramp is under way */
  ramping: boolean;
  /** The limit in force, km/h */
  speedLimit: number;
  /** The limit above LIMIT_CONFIRM_ABOVE was confirmed */
  limitConfirmed: boolean;
  /** km/h per command while ramping */
  maxStep: number;
  /** What the treadmill reported (defaults before it did) */
  deviceRange: { min: number; max: number };
  /** The highest speed that is ever sent: the device maximum, capped by the limit */
  effectiveMax: number;
  /** The incline range the treadmill reported */
  inclineRange: Range | null;
  /** The treadmill gave control away; the next Start or Stop asks for it again */
  controlLost: boolean;
  /** A Stop or Pause did not get through while connected: the person has to stop the belt on the treadmill */
  stopFailed: boolean;
  /** What setProgramActive said */
  programActive: boolean;
}

/** The events of Treadmill.on and what each one carries */
export interface TreadmillEventMap {
  /** What the treadmill reports, about once a second */
  data: TreadmillData;
  /** Beats per minute from the Heart Rate service */
  heartRate: number;
  /** The treadmill reported a change (stopped, safety key, control lost, …) */
  machineStatus: { event: MachineEvent | null; hex: string };
  /** The treadmill's training status (e.g. 'Pre-Workout') */
  trainingStatus: { hex: string; status: number | null; text: string | null };
  /** Every answer of the treadmill to a command, also an OK (result 1) */
  controlResponse: ControlPointResponse;
  /** Something to tell the person or a log, as a code: turn it into words in your language */
  notice: Notice;
  /** Protocol lines (bytes sent, an answer that could not be read); not for people */
  log: string;
  /** The belt was stopped or stopped by itself: a running program ends. Once per run of the belt (a stop and the treadmill reporting it are one) */
  ended: { reason: EndReason };
  /** true: a Stop or Pause did not get through, the person has to stop the belt on the treadmill; false: one did later */
  stopFailed: boolean;
  /** The belt phase may have changed because of a command or a report (it also changes with time: read state.belt) */
  phase: BeltPhase;
  /** Target, last command or ramp changed */
  target: undefined;
  /** The connection is gone; wasRunning: the belt may still be moving */
  disconnected: { wasRunning: boolean };
}

/** What Treadmill.sendRaw did */
export type RawResult =
  | { action: 'not-connected' }
  | { action: 'blocked'; reason: ConsoleBlock }
  | { action: 'needs-confirmation' }
  | { action: 'sent'; ok: boolean };

type Listener<E extends keyof TreadmillEventMap> = (e: TreadmillEventMap[E]) => void;

/**
 * One treadmill: the connection, what is known about the belt, and everything that drives it. Made by createTreadmill.
 * No method throws once connected (only connect can); a command that fails returns false or null and sends a notice.
 * Speeds in km/h, incline in percent. Every part with an example: docs/API.md.
 */
export interface Treadmill {
  /**
   * Asks the adapter for a device (Web Bluetooth: the browser's picker, so call it from a click), connects, reads what the
   * treadmill can do and asks for control. Again while connected: the same result.
   * @throws the adapter's error when no device was chosen or it has no FTMS service
   */
  connect(adapter: BleAdapter): Promise<ConnectResult>;
  /** Ends the connection; disconnected follows. Does not stop the belt: stop first if it may be running. */
  disconnect(): void;
  /**
   * Asks for control, sets the lowest speed, sends Start, then ramps up to the last speed asked for.
   * @returns false if a command failed, or a Stop or Pause came in meanwhile (then nothing more of it is sent)
   */
  start(): Promise<boolean>;
  /**
   * Stops the belt: ends the ramp and a running program (ended), sends Stop ahead of everything queued, and again up to
   * STOP_ATTEMPTS times. Always allowed while connected.
   * @returns false if it did not get through; then state.stopFailed is true and the person has to stop the belt on the treadmill
   */
  stop(): Promise<boolean>;
  /** Like stop, with Pause (the treadmill keeps distance and time); start resumes at the speed before. */
  pause(): Promise<boolean>;
  /**
   * The speed to go to. Reached in steps of at most maxStep, one every RAMP_INTERVAL_MS, only while the belt moves; held
   * until it does. Never above state.effectiveMax.
   * @param options.source 'program' for a workout or route (watched for a belt that stands still), 'manual' (default) for the person
   * @returns the target it ramps to, or null if not connected or no speed is allowed
   */
  setSpeed(kmh: number, options?: { source?: CommandSource }): number | null;
  /** setSpeed relative to the current target (or the speed last sent), for + and − buttons. */
  changeSpeed(deltaKmh: number, options?: { source?: CommandSource }): number | null;
  /**
   * Sets the incline, clamped to the treadmill's range and rounded to 0.1 %.
   * @returns false if the treadmill cannot set an incline, pct is not a number or the command failed
   */
  setIncline(pct: number): Promise<boolean>;
  /**
   * Changes the limit or the ramp step. Lowering takes effect at once. A limit above LIMIT_CONFIRM_ABOVE needs
   * limitConfirmed: true in the same call, otherwise LIMIT_CONFIRM_ABOVE is used and limit-unconfirmed is sent.
   */
  setLimits(limits: { speedLimit?: number; limitConfirmed?: boolean; maxStep?: number }): void;
  /**
   * A workout or route of yours runs: Start stays locked meanwhile. false ends the standstill watch. End the program on
   * ended; true starts a new run, so the program always hears about its end.
   */
  setProgramActive(active: boolean): void;
  /**
   * Sends Control Point bytes as they are (an experiment console), after checking them against the limit, the step and
   * the interval. A raw Start needs confirmed: true.
   */
  sendRaw(bytes: number[], options?: { confirmed?: boolean }): Promise<RawResult>;
  /** A fresh snapshot each time it is read: read it when you draw. */
  readonly state: TreadmillState;
  /**
   * Listens to an event. A listener that throws is reported a moment later and never gets in the way of a Stop.
   * @returns the function that removes the listener
   */
  on<E extends keyof TreadmillEventMap>(event: E, listener: (payload: TreadmillEventMap[E]) => void): () => void;
}

/** Before the treadmill says otherwise */
const DEFAULT_DEVICE_RANGE = { min: 1.0, max: 12.0 };

const realClock: Clock = {
  now: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** Makes a treadmill. It is not connected yet: give it an adapter with connect. Keeps its limits across connections. */
export function createTreadmill(opts: TreadmillOptions = {}): Treadmill {
  const clock = opts.clock ?? realClock;
  const now = () => clock.now();
  const session = new BeltState();
  const tracker = new BeltPhaseTracker();
  const standstill = new StandstillDetector();
  const listeners = new Map<keyof TreadmillEventMap, Set<Listener<keyof TreadmillEventMap>>>();
  let deviceRange = { ...DEFAULT_DEVICE_RANGE };
  let info: ConnectResult | null = null;
  let speedLimit = DEFAULT_SPEED_LIMIT;
  let limitConfirmed = false;
  let stopFailed = false;
  let programActive = false;
  /** The last speed asked for; a stop forgets the target, the next Start ramps up to this again (what the app still shows) */
  let wanted: number | null = null;
  /**
   * The current run of the belt has been told to have ended. One end is told once: a stop and then the treadmill reporting
   * that stop is one ended, not two. A new run opens it again: a start (by the app, raw or on the treadmill), the belt
   * measured moving after it stood, a program that begins, a new connection. When in doubt it opens: an end told twice is
   * harmless, an end not told would leave a program running.
   */
  let runEnded = false;
  const newRun = () => { runEnded = false; };
  function ended(reason: EndReason) {
    if (runEnded) return;
    runEnded = true;
    emit('ended', { reason });
  }

  /** A listener is the app's display: whatever it does, it never gets in the way of the control path */
  function emit<E extends keyof TreadmillEventMap>(event: E, payload: TreadmillEventMap[E]) {
    for (const cb of listeners.get(event) ?? []) {
      try { (cb as Listener<E>)(payload); } catch (e) { queueMicrotask(() => { throw e; }); }
    }
  }

  const notice = (n: Notice) => emit('notice', n);

  const governor = new SpeedGovernor({
    send: kmh => session.send(cmdSetSpeed(kmh)),
    now,
    notice,
    onChange: () => {
      if (governor.target !== null) wanted = governor.target;
      emit('target', undefined);
    },
  });
  governor.maxStep = DEFAULT_MAX_STEP;

  const phase = {
    startRequested(at: number) { tracker.startRequested(at); emit('phase', tracker.phase(at)); },
    stopRequested(at: number) { tracker.stopRequested(at); emit('phase', tracker.phase(at)); },
    speed(kmh: number, at: number) {
      tracker.speed(kmh, at);
      // Moving while no stop is under way: the belt was started again (perhaps on the treadmill, without telling)
      if (kmh >= MOVING_KMH && tracker.phase(at) === 'running') newRun();
    },
  };

  function setStopFailed(failed: boolean) {
    stopFailed = failed;
    emit('stopFailed', failed);
  }

  const belt = setupBelt({
    session, phase, governor, standstill, now,
    wanted: () => wanted,
    ended,
    notice,
    wait: ms => clock.wait(ms),
    stopFailed: setStopFailed,
  });

  const reports = setupReports({
    session, phase, governor, standstill, now,
    programActive: () => programActive,
    ended,
    stopFailed: setStopFailed,
    notice,
    data: d => emit('data', d),
    machineStatus: s => {
      if (s.event?.kind === 'started') newRun();
      emit('machineStatus', s);
    },
    controlResponse: r => emit('controlResponse', r),
  });

  const effectiveMax = () => Math.min(deviceRange.max, speedLimit);

  /** The governor follows the device range and the limit; a target above a lowered limit comes down */
  function applyRange() {
    const before = governor.target;
    governor.setRange({ min: deviceRange.min, max: effectiveMax() });
    if (session.connected() && governor.target !== before && governor.target !== null) notice({ code: 'limit-lowered', kmh: governor.target });
  }

  /** A limit above LIMIT_CONFIRM_ABOVE only with a confirmation; nonsense is the default limit */
  function takeLimit(requested: number, confirmed: boolean) {
    let v = Number.isFinite(requested) ? Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, requested)) : DEFAULT_SPEED_LIMIT;
    if (v > LIMIT_CONFIRM_ABOVE && !confirmed) {
      notice({ code: 'limit-unconfirmed', requested: v, applied: LIMIT_CONFIRM_ABOVE });
      v = LIMIT_CONFIRM_ABOVE;
      confirmed = false;
    }
    speedLimit = v;
    limitConfirmed = confirmed && v > LIMIT_CONFIRM_ABOVE;
  }

  function takeMaxStep(v: number) {
    if (Number.isFinite(v)) governor.maxStep = Math.min(MAX_STEP_MAX, Math.max(MAX_STEP_MIN, v));
  }

  takeLimit(opts.speedLimit ?? DEFAULT_SPEED_LIMIT, opts.limitConfirmed ?? false);
  if (opts.maxStep !== undefined) takeMaxStep(opts.maxStep);
  applyRange();

  function onDisconnected() {
    const wasRunning = session.maybeRunning();
    governor.reset();
    standstill.disarm();
    session.client = null;
    session.forgetBelt();
    tracker.setConnected(false);
    stopFailed = false;
    emit('disconnected', { wasRunning });
  }

  async function connect(adapter: BleAdapter): Promise<ConnectResult> {
    if (session.connected() && info) return info;
    const client = new TreadmillClient(adapter, {
      log: m => emit('log', m),
      notice,
      data: reports.data,
      heartRate: bpm => emit('heartRate', bpm),
      machineStatus: reports.machineStatus,
      trainingStatus: dv => {
        const s = parseTrainingStatus(dv);
        emit('trainingStatus', { hex: hex(dv), status: s?.status ?? null, text: s?.text ?? null });
      },
      controlResponse: reports.controlResponse,
      disconnected: onDisconnected,
    });
    session.begin(client);
    deviceRange = { ...DEFAULT_DEVICE_RANGE };
    info = null;
    let result: ConnectResult;
    try {
      result = await client.connect();
    } catch (e) {
      if (!session.connected()) session.client = null;
      throw e;
    }
    if (result.speedRange) deviceRange = { min: result.speedRange.min, max: result.speedRange.max };
    info = result;
    governor.reset();
    applyRange();
    tracker.setConnected(true);
    newRun();
    stopFailed = false;
    emit('phase', tracker.phase(now()));
    await client.send(cmdRequestControl());
    return result;
  }

  function setSpeed(kmh: number, o: { source?: CommandSource } = {}): number | null {
    if (!session.connected() || !Number.isFinite(kmh)) return null;
    const target = governor.request(kmh);
    // In 0.x only a program watches for a belt that stands still (docs/LIBRARY.md, Standstill)
    if (o.source === 'program') standstill.arm();
    return target;
  }

  async function sendRaw(bytes: number[], o: { confirmed?: boolean } = {}): Promise<RawResult> {
    const c = session.client;
    if (!c) return { action: 'not-connected' };
    const check = checkConsoleCommand(bytes, {
      maxKmh: effectiveMax(),
      maxStep: governor.maxStep,
      baseKmh: governor.base(),
      msSinceLastSpeedCommand: governor.msSinceLastCommand(),
    });
    if (check.action === 'block') return { action: 'blocked', reason: check.reason };
    const data = new Uint8Array(bytes);
    if (check.action === 'confirm-start') {
      if (!o.confirmed) return { action: 'needs-confirmation' };
      governor.reset();
      newRun();
      const ok = await c.send(data);
      if (ok) session.beltStarted = true;
      return { action: 'sent', ok };
    }
    if (bytes[0] === OP.STOP_PAUSE && (bytes[1] === 0x01 || bytes[1] === 0x02)) {
      ended('console');
      governor.reset();
      standstill.disarm();
      const ok = await c.send(data, { urgent: true });
      if (ok) session.beltStarted = false;
      return { action: 'sent', ok };
    }
    if (check.setSpeed !== undefined) governor.noteExternalCommand(check.setSpeed);
    return { action: 'sent', ok: await c.send(data) };
  }

  return {
    connect,
    disconnect() { session.client?.disconnect(); },
    start() {
      newRun();
      return belt.start();
    },
    stop: belt.stop,
    pause: belt.pause,
    setSpeed,
    changeSpeed(deltaKmh: number, o: { source?: CommandSource } = {}) {
      return setSpeed((governor.target ?? governor.base()) + deltaKmh, o);
    },
    setIncline(pct: number): Promise<boolean> {
      const range = info?.inclRange;
      if (!inclineSupport(info?.features, range).settable) return Promise.resolve(false);
      const p = clampIncline(pct, range);
      return Number.isNaN(p) ? Promise.resolve(false) : session.send(cmdSetInclination(p));
    },
    setLimits(l: { speedLimit?: number; limitConfirmed?: boolean; maxStep?: number }) {
      if (l.speedLimit !== undefined) takeLimit(l.speedLimit, l.limitConfirmed ?? false);
      if (l.maxStep !== undefined) takeMaxStep(l.maxStep);
      applyRange();
    },
    setProgramActive(active: boolean) {
      if (active && !programActive) newRun();
      programActive = active;
      if (!active) standstill.disarm();
    },
    sendRaw,
    get state(): TreadmillState {
      const t = now();
      const belt = tracker.phase(t);
      return {
        connected: session.connected(),
        belt,
        controls: controlAvailability({
          connected: session.connected(),
          measuredKmh: session.lastMeasured,
          measuredAgeMs: t - session.lastMeasuredAt,
          startedByApp: session.beltStarted,
          startingNow: belt === 'starting',
          programActive,
        }),
        maybeRunning: session.maybeRunning(),
        lastMeasured: session.lastMeasured,
        target: governor.target,
        lastCommand: governor.lastCommand,
        ramping: governor.ramping,
        speedLimit,
        limitConfirmed,
        maxStep: governor.maxStep,
        deviceRange: { ...deviceRange },
        effectiveMax: effectiveMax(),
        inclineRange: info?.inclRange ?? null,
        controlLost: session.controlLost,
        stopFailed,
        programActive,
      };
    },
    on<E extends keyof TreadmillEventMap>(event: E, cb: Listener<E>): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(cb as Listener<keyof TreadmillEventMap>);
      return () => { set.delete(cb as Listener<keyof TreadmillEventMap>); };
    },
  };
}
