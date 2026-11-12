// BLE layer: adapter interface (GATT level), serial write queue
// and the FTMS connection sequence. The Web Bluetooth adapter is in web-bluetooth.ts; another one (e.g. native)
// only implements BleAdapter/BleDevice.

import {
  CH, DEVINFO_CH, DEVINFO_SERVICE, FTMS_SERVICE, HR_SERVICE,
  hex, parseControlPointResponse, parseFeatures,
  parseHeartRate, parseInclinationRange, parseSpeedRange, parseTreadmillData,
  type ControlPointResponse, type Features, type Range, type TreadmillData,
} from '../protocol/ftms.ts';
import { TreadmillError, type Notice } from '../protocol/notice.ts';

export type Uuid = number;

export interface BleDevice {
  readonly name: string | undefined;
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  /** Called exactly once per connection, also when disconnecting manually. */
  onDisconnected(cb: () => void): void;
  read(service: Uuid, characteristic: Uuid): Promise<DataView>;
  /** The listener is registered before notifications are enabled. */
  subscribe(service: Uuid, characteristic: Uuid, cb: (dv: DataView) => void): Promise<void>;
  /** Write with Response. */
  write(service: Uuid, characteristic: Uuid, data: Uint8Array): Promise<void>;
}

export type BleAvailability =
  | { ok: true }
  | { ok: false; reason: 'no-api' | 'no-adapter' };

export interface BleAdapter {
  readonly kind: string;
  availability(): Promise<BleAvailability>;
  /** Opens the device chooser. */
  requestDevice(optionalServices: Uuid[]): Promise<BleDevice>;
}

// ---------- Serial queue ----------

/** A waiting task was displaced by an urgent task. */
export class DroppedError extends Error {
  constructor() { super('dropped'); this.name = 'DroppedError'; }
}

interface Job {
  /** Stop or Pause: never dropped for another one */
  urgent: boolean;
  task: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/** Runs tasks strictly one after another. An error does not break the chain. */
export class SerialQueue {
  private pending: Job[] = [];
  private running = false;

  run<T>(task: () => Promise<T>): Promise<T> {
    return this.add(task, false);
  }

  /**
   * Rejects the ordinary tasks that have not started yet (DroppedError) and queues `task` next. Urgent tasks that are still
   * waiting stay, in their order: a Pause never displaces a Stop. A task that is already running is awaited; nothing ever
   * runs in parallel.
   */
  runUrgent<T>(task: () => Promise<T>): Promise<T> {
    const waiting = this.pending.splice(0);
    for (const job of waiting) {
      if (job.urgent) this.pending.push(job); else job.reject(new DroppedError());
    }
    return this.add(task, true);
  }

  private add<T>(task: () => Promise<T>, urgent: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ urgent, task, resolve: resolve as (v: unknown) => void, reject });
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.pending.shift(); job; job = this.pending.shift()) {
        try { job.resolve(await job.task()); } catch (e) { job.reject(e); }
      }
    } finally {
      this.running = false;
    }
  }
}

// ---------- FTMS client ----------

export interface TreadmillEvents {
  /** Protocol lines (bytes sent, a response that could not be read), for the console; not for people */
  log(msg: string): void;
  /** What was found or went wrong, as a code; the app says it in its language */
  notice(n: Notice): void;
  data(d: TreadmillData): void;
  heartRate(bpm: number): void;
  machineStatus(dv: DataView): void;
  trainingStatus(dv: DataView): void;
  /** What the treadmill answered to a command: a write that went through is not yet a command it accepted */
  controlResponse(r: ControlPointResponse): void;
  disconnected(): void;
}

export interface ConnectResult {
  deviceName: string | undefined;
  features?: Features;
  speedRange?: Range;
  inclRange?: Range;
  hasHeartRate: boolean;
}

/**
 * A write that gets no answer from the treadmill is given up on after this long, so that the writes behind it, above all
 * Stop, are not held back for ever by one that never returns.
 */
export const WRITE_TIMEOUT_MS = 5000;

/** The write, or an error if it has not finished in time. The timer never outlives the write. */
function withTimeout(write: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TreadmillError('write-timeout')), WRITE_TIMEOUT_MS); });
  return Promise.race([write, timeout]).finally(() => clearTimeout(timer));
}

export class TreadmillClient {
  private device: BleDevice | null = null;
  private readonly queue = new SerialQueue();

  constructor(private readonly adapter: BleAdapter, private readonly ev: TreadmillEvents) {}

  get adapterKind() { return this.adapter.kind; }
  get connected() { return !!this.device?.connected; }

  /** Same sequence as the prototype, including the order of GATT accesses. */
  async connect(): Promise<ConnectResult> {
    const { ev } = this;
    const device = await this.adapter.requestDevice([FTMS_SERVICE, HR_SERVICE, DEVINFO_SERVICE]);
    ev.notice({ code: 'device', name: device.name });
    device.onDisconnected(() => {
      if (this.device === device) this.device = null;
      ev.disconnected();
    });
    try {
      await device.connect();
      this.device = device;

      await device.subscribe(FTMS_SERVICE, CH.control, dv => {
        const r = parseControlPointResponse(dv);
        if (r) ev.controlResponse(r);
        else ev.log(`← CP ${hex(dv)}`);
      });
      await device.subscribe(FTMS_SERVICE, CH.treadmillData, dv => ev.data(parseTreadmillData(dv)));

      const statusChars: [Uuid, (dv: DataView) => void][] = [
        [CH.machineStatus, dv => ev.machineStatus(dv)],
        [CH.trainingStatus, dv => ev.trainingStatus(dv)],
      ];
      for (const [uuid, cb] of statusChars) {
        try { await device.subscribe(FTMS_SERVICE, uuid, cb); }
        catch { ev.notice({ code: 'not-subscribable', uuid }); }
      }

      const infoChars = ['manufacturer', 'model', 'firmware'] as const;
      for (const field of infoChars) {
        try { ev.notice({ code: 'device-info', field, value: new TextDecoder().decode(await device.read(DEVINFO_SERVICE, DEVINFO_CH[field])) }); }
        catch { /* optional */ }
      }

      const result: ConnectResult = { deviceName: device.name, hasHeartRate: false };

      try {
        result.features = parseFeatures(await device.read(FTMS_SERVICE, CH.feature));
        ev.notice({ code: 'features', names: result.features.machineNames });
        ev.notice({ code: 'controllable', names: result.features.targetNames });
      } catch { ev.notice({ code: 'features-unreadable' }); }

      try {
        const r = parseSpeedRange(await device.read(FTMS_SERVICE, CH.speedRange));
        result.speedRange = r;
        ev.notice({ code: 'speed-range', range: r });
      } catch { ev.notice({ code: 'speed-range-unreadable' }); }

      try {
        const r = parseInclinationRange(await device.read(FTMS_SERVICE, CH.inclRange));
        result.inclRange = r;
        ev.notice({ code: 'incline-range', range: r });
      } catch { ev.notice({ code: 'incline-range-unreadable' }); }

      try {
        await device.subscribe(HR_SERVICE, CH.hr, dv => ev.heartRate(parseHeartRate(dv)));
        result.hasHeartRate = true;
        ev.notice({ code: 'heart-rate', available: true });
      } catch { ev.notice({ code: 'heart-rate', available: false }); }

      return result;
    } catch (e) {
      try { device.disconnect(); } catch { /* ignore */ }
      throw e;
    }
  }

  disconnect() {
    this.device?.disconnect();
  }

  /**
   * Writes to the Control Point. All writes go serially through a queue, with response.
   * `urgent` (stop/pause): waiting ordinary writes are dropped, the running one is awaited.
   * Resolves to false on error, timeout or when dropped (all are logged), never throws.
   */
  send(bytes: Uint8Array, opts: { urgent?: boolean } = {}): Promise<boolean> {
    const task = async () => {
      this.ev.log(`→ ${hex(bytes)}`);
      const d = this.device;
      if (!d?.connected) throw new TreadmillError('not-connected');
      await withTimeout(d.write(FTMS_SERVICE, CH.control, bytes));
    };
    return (opts.urgent ? this.queue.runUrgent(task) : this.queue.run(task)).then(
      () => true,
      (e: unknown) => {
        if (e instanceof DroppedError) this.ev.notice({ code: 'write-dropped', bytes: hex(bytes) });
        else this.ev.notice({ code: 'write-failed', error: e instanceof TreadmillError ? e.code : { message: e instanceof Error ? e.message : String(e) } });
        return false;
      },
    );
  }
}
