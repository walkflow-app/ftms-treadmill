// The treadmill as one object with a defined API (docs/LIBRARY.md): connect, start, stop, pause, a speed and an incline, the
// limits, and what the treadmill reports. It owns everything that drives the belt (the governor, the standstill detection,
// the belt phase, the order of start and stop), so that the app only draws and asks. It becomes the ftms-treadmill library.
// No texts and no DOM: what it has to say is a Notice code, the app says it in its language.

import { cmdRequestControl, cmdSetInclination, cmdSetSpeed, hex, OP, parseTrainingStatus, type ControlPointResponse, type MachineEvent, type Range, type TreadmillData } from '../protocol/ftms.ts';
import type { ConsoleBlock, Notice } from '../protocol/notice.ts';
import { BeltPhaseTracker, type BeltPhase } from '../safety/belt-phase.ts';
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

export interface Clock {
  now(): number;
  wait(ms: number): Promise<void>;
}

export interface TreadmillOptions {
  /** km/h, LIMIT_MIN..LIMIT_MAX; above LIMIT_CONFIRM_ABOVE only with limitConfirmed */
  speedLimit?: number;
  /** A person confirmed a limit above LIMIT_CONFIRM_ABOVE; belongs to the speedLimit it is given with */
  limitConfirmed?: boolean;
  /** km/h per command while ramping */
  maxStep?: number;
  clock?: Clock;
}

export interface TreadmillState {
  connected: boolean;
  belt: BeltPhase;
  /** Which buttons may be used now. Stop is there whenever the treadmill is connected. */
  controls: { start: boolean; pause: boolean; stop: boolean };
  /** When in doubt true */
  maybeRunning: boolean;
  /** The last speed the treadmill reported, km/h */
  lastMeasured: number | undefined;
  /** Where the ramp is going */
  target: number | null;
  lastCommand: { kmh: number; at: number } | null;
  ramping: boolean;
  speedLimit: number;
  limitConfirmed: boolean;
  maxStep: number;
  /** What the treadmill reported (defaults before it did) */
  deviceRange: { min: number; max: number };
  /** The highest speed that is ever sent: the device maximum, capped by the limit */
  effectiveMax: number;
  inclineRange: Range | null;
  controlLost: boolean;
  /** A Stop or Pause did not get through while connected: the person has to stop the belt on the treadmill */
  stopFailed: boolean;
  programActive: boolean;
}

export interface TreadmillEventMap {
  data: TreadmillData;
  heartRate: number;
  machineStatus: { event: MachineEvent | null; hex: string };
  trainingStatus: { hex: string; status: number | null; text: string | null };
  controlResponse: ControlPointResponse;
  notice: Notice;
  /** Protocol lines (bytes sent, an answer that could not be read); not for people */
  log: string;
  /** The belt was stopped or stopped by itself: a running program ends */
  ended: { reason: EndReason };
  stopFailed: boolean;
  /** The belt phase may have changed because of a command or a report (it also changes with time: read state.belt) */
  phase: BeltPhase;
  /** Target, last command or ramp changed */
  target: undefined;
  disconnected: { wasRunning: boolean };
}

export type RawResult =
  | { action: 'not-connected' }
  | { action: 'blocked'; reason: ConsoleBlock }
  | { action: 'needs-confirmation' }
  | { action: 'sent'; ok: boolean };

type Listener<E extends keyof TreadmillEventMap> = (e: TreadmillEventMap[E]) => void;

/** Before the treadmill says otherwise */
const DEFAULT_DEVICE_RANGE = { min: 1.0, max: 12.0 };

const realClock: Clock = {
  now: () => performance.now(),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export function createTreadmill(opts: TreadmillOptions = {}) {
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
    speed(kmh: number, at: number) { tracker.speed(kmh, at); },
  };

  function setStopFailed(failed: boolean) {
    stopFailed = failed;
    emit('stopFailed', failed);
  }

  const belt = setupBelt({
    session, phase, governor, standstill, now,
    wanted: () => wanted,
    ended: reason => emit('ended', { reason }),
    notice,
    wait: ms => clock.wait(ms),
    stopFailed: setStopFailed,
  });

  const reports = setupReports({
    session, phase, governor, standstill, now,
    programActive: () => programActive,
    ended: reason => emit('ended', { reason }),
    stopFailed: setStopFailed,
    notice,
    data: d => emit('data', d),
    machineStatus: s => emit('machineStatus', s),
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
      const ok = await c.send(data);
      if (ok) session.beltStarted = true;
      return { action: 'sent', ok };
    }
    if (bytes[0] === OP.STOP_PAUSE && (bytes[1] === 0x01 || bytes[1] === 0x02)) {
      emit('ended', { reason: 'console' });
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
    start: belt.start,
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

export type Treadmill = ReturnType<typeof createTreadmill>;
