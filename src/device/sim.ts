// Simulated FTMS treadmill for demo mode and tests. Implements BleAdapter/BleDevice at GATT level
// and speaks real FTMS bytes, so parser, client and queue run exactly as with hardware.
// The behaviour is plausible, not measured. In particular, the simulated belt keeps running when the
// connection drops (the dangerous assumption from the project brief).

import type { BleAdapter, BleAvailability, BleDevice, Uuid } from './ble.ts';
import { buildTreadmillData, CH, DEVINFO_CH, DEVINFO_SERVICE, FTMS_SERVICE, HR_SERVICE, OP } from '../protocol/ftms.ts';

export interface SimOptions {
  name: string;
  /** km/h */
  speedRange: [min: number, max: number, step: number];
  /** % */
  inclRange: [min: number, max: number, step: number];
  /** false: a treadmill that cannot be set to an incline and reports none */
  incline: boolean;
  heartRate: boolean;
  countdownMs: number;
  /** Belt acceleration in km/h per second */
  accel: number;
  tickMs: number;
  notifyMs: number;
  connectDelayMs: number;
  writeDelayMs: number;
  version: string;
}

const DEFAULTS: SimOptions = {
  name: 'Walkflow Simulator',
  speedRange: [1, 8, 0.1],
  inclRange: [0, 10, 1],
  incline: true,
  heartRate: false,
  countdownMs: 3000,
  accel: 1,
  tickMs: 100,
  notifyMs: 1000,
  connectDelayMs: 300,
  writeDelayMs: 20,
  version: 'dev',
};

type BeltState = 'stopped' | 'countdown' | 'running' | 'paused';

const le16 = (v: number) => { const x = Math.round(v) & 0xffff; return [x & 0xff, x >> 8]; };
const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

/** The "physical" belt. Lives on across connections. */
export class SimulatedBelt {
  state: BeltState = 'stopped';
  /** actual speed */
  speed = 0;
  target = 0;
  incline = 0;
  dist = 0;
  elapsed = 0;
  kcal = 0;
  private countdownLeft = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** called on state changes (Machine Status, Training Status) */
  onMachineStatus: ((bytes: number[]) => void) | null = null;
  onTrainingStatus: ((bytes: number[]) => void) | null = null;

  constructor(readonly opts: SimOptions) {}

  get moving() { return this.state !== 'stopped' || this.speed > 0; }

  start() {
    if (this.state === 'running' || this.state === 'countdown') return;
    if (this.state === 'stopped') {
      this.dist = 0; this.elapsed = 0; this.kcal = 0;
      this.target = this.opts.speedRange[0];
    }
    this.state = 'countdown';
    this.countdownLeft = this.opts.countdownMs;
    this.onMachineStatus?.([0x04]);
    this.onTrainingStatus?.([0x00, 0x0e]);
    this.ensureTimer();
  }

  stop(kind: 'stop' | 'pause' | 'safety-key') {
    if (this.state === 'stopped' && kind !== 'safety-key') return;
    this.state = kind === 'pause' ? 'paused' : 'stopped';
    if (kind === 'safety-key') { this.speed = 0; this.onMachineStatus?.([0x03]); }
    else this.onMachineStatus?.([0x02, kind === 'pause' ? 0x02 : 0x01]);
    this.onTrainingStatus?.([0x00, 0x01]);
    this.ensureTimer();
  }

  setTarget(kmh: number) {
    this.target = kmh;
    this.onMachineStatus?.([0x05, ...le16(kmh * 100)]);
  }

  setIncline(pct: number) {
    this.incline = pct;
    this.onMachineStatus?.([0x06, ...le16(pct * 10)]);
  }

  private ensureTimer() {
    if (this.timer === null) this.timer = setInterval(() => this.step(this.opts.tickMs / 1000), this.opts.tickMs);
  }

  dispose() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Physics, dt in seconds */
  step(dt: number) {
    if (this.state === 'countdown') {
      this.countdownLeft -= dt * 1000;
      if (this.countdownLeft <= 0) {
        this.state = 'running';
        this.onTrainingStatus?.([0x00, 0x0d]);
      }
    }
    const goal = this.state === 'running' ? this.target : 0;
    const maxDelta = (this.state === 'running' ? this.opts.accel : this.opts.accel * 2) * dt;
    const d = goal - this.speed;
    this.speed = Math.abs(d) <= maxDelta ? goal : this.speed + Math.sign(d) * maxDelta;
    if (this.speed < 0.01) this.speed = 0;
    const meters = (this.speed / 3.6) * dt;
    this.dist += meters;
    this.kcal += meters * 0.05; // rough estimate, demo only
    if (this.state === 'running') this.elapsed += dt;
    if (this.state === 'stopped' && this.speed === 0 && !this.keepAlive) this.dispose();
  }

  /** While a device is connected, the physics keep running (for notifications). */
  keepAlive = false;
  touch() { this.ensureTimer(); }
}

class SimDevice implements BleDevice {
  connected = false;
  private subs = new Map<string, (dv: DataView) => void>();
  private notifyTimer: ReturnType<typeof setInterval> | null = null;
  private disconnectCb: (() => void) | null = null;
  private control = false;

  constructor(private readonly belt: SimulatedBelt, private readonly opts: SimOptions) {}

  get name() { return this.opts.name; }

  connect() {
    return new Promise<void>(resolve => setTimeout(() => {
      this.connected = true;
      this.control = false;
      this.belt.keepAlive = true;
      this.belt.touch();
      this.belt.onMachineStatus = b => this.notify(FTMS_SERVICE, CH.machineStatus, b);
      this.belt.onTrainingStatus = b => this.notify(FTMS_SERVICE, CH.trainingStatus, b);
      this.notifyTimer = setInterval(() => this.sendData(), this.opts.notifyMs);
      resolve();
    }, this.opts.connectDelayMs));
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.control = false;
    if (this.notifyTimer !== null) clearInterval(this.notifyTimer);
    this.notifyTimer = null;
    this.subs.clear();
    this.belt.onMachineStatus = null;
    this.belt.onTrainingStatus = null;
    this.belt.keepAlive = false;
    this.belt.touch(); // the belt keeps running, and so do the physics
    const cb = this.disconnectCb;
    this.disconnectCb = null;
    cb?.();
  }

  onDisconnected(cb: () => void) { this.disconnectCb = cb; }

  async read(service: Uuid, characteristic: Uuid): Promise<DataView> {
    this.assertConnected();
    const { speedRange: [smin, smax, sstep], inclRange: [imin, imax, istep] } = this.opts;
    const text = (s: string) => new DataView(new TextEncoder().encode(s).buffer);
    if (service === DEVINFO_SERVICE) {
      if (characteristic === DEVINFO_CH.manufacturer) return text('Walkflow');
      if (characteristic === DEVINFO_CH.model) return text('Simulator');
      if (characteristic === DEVINFO_CH.firmware) return text(this.opts.version);
    }
    if (service === FTMS_SERVICE) {
      // Machine: Total Distance, Inclination, Expended Energy, Elapsed Time (+ Heart Rate)
      // Target: Speed, Inclination
      const machine = 0x0004 | (this.opts.incline ? 0x0008 : 0) | 0x0200 | 0x1000 | (this.opts.heartRate ? 0x0400 : 0);
      if (characteristic === CH.feature) return dv([machine & 0xff, machine >> 8, 0, 0, this.opts.incline ? 0x03 : 0x01, 0, 0, 0]);
      if (characteristic === CH.speedRange) return dv([...le16(smin * 100), ...le16(smax * 100), ...le16(sstep * 100)]);
      if (characteristic === CH.inclRange && this.opts.incline) return dv([...le16(imin * 10), ...le16(imax * 10), ...le16(istep * 10)]);
    }
    throw new Error('Characteristic not found');
  }

  async subscribe(service: Uuid, characteristic: Uuid, cb: (dv: DataView) => void) {
    this.assertConnected();
    const ok = service === FTMS_SERVICE
      ? ([CH.control, CH.treadmillData, CH.machineStatus, CH.trainingStatus] as number[]).includes(characteristic)
      : service === HR_SERVICE && characteristic === CH.hr && this.opts.heartRate;
    if (!ok) throw new Error('Characteristic not found');
    this.subs.set(`${service}/${characteristic}`, cb);
  }

  async write(service: Uuid, characteristic: Uuid, data: Uint8Array) {
    this.assertConnected();
    if (service !== FTMS_SERVICE || characteristic !== CH.control) throw new Error('Characteristic not writable');
    await new Promise(r => setTimeout(r, this.opts.writeDelayMs));
    this.assertConnected();
    const bytes = [...data];
    const result = this.handleControl(bytes);
    setTimeout(() => this.notify(FTMS_SERVICE, CH.control, [OP.RESPONSE, bytes[0] ?? 0, result]), 10);
  }

  private handleControl(b: number[]): number {
    const op = b[0];
    if (op === OP.REQUEST_CONTROL) { this.control = true; return 1; }
    if (!this.control) return 5;
    const { speedRange: [smin, smax], inclRange: [imin, imax] } = this.opts;
    switch (op) {
      case OP.START: this.belt.start(); return 1;
      case OP.STOP_PAUSE:
        if (b[1] === 0x01) { this.belt.stop('stop'); return 1; }
        if (b[1] === 0x02) { this.belt.stop('pause'); return 1; }
        return 3;
      case OP.SET_SPEED: {
        if (b.length !== 3) return 3;
        const kmh = ((b[1] ?? 0) | ((b[2] ?? 0) << 8)) / 100;
        if (kmh < smin || kmh > smax) return 3;
        this.belt.setTarget(kmh);
        return 1;
      }
      case OP.SET_INCL: {
        if (!this.opts.incline) return 2;
        if (b.length !== 3) return 3;
        const pct = new DataView(new Uint8Array(b).buffer).getInt16(1, true) / 10;
        if (pct < imin || pct > imax) return 3;
        this.belt.setIncline(pct);
        return 1;
      }
      default: return 2;
    }
  }

  private sendData() {
    const b = this.belt;
    this.notify(FTMS_SERVICE, CH.treadmillData, [...buildTreadmillData({
      speed: Math.round(b.speed * 100) / 100,
      dist: Math.floor(b.dist),
      incl: this.opts.incline ? b.incline : undefined,
      rampAngle: 0,
      kcal: Math.floor(b.kcal),
      time: Math.floor(b.elapsed),
    })]);
    if (this.opts.heartRate) this.notify(HR_SERVICE, CH.hr, [0x00, b.speed > 0 ? Math.round(70 + b.speed * 8) : 0]);
  }

  private notify(service: Uuid, characteristic: Uuid, bytes: number[]) {
    if (!this.connected) return;
    this.subs.get(`${service}/${characteristic}`)?.(dv(bytes));
  }

  private assertConnected() {
    if (!this.connected) throw new Error('GATT server is disconnected');
  }
}

export class SimulatorAdapter implements BleAdapter {
  readonly kind = 'simulator';
  readonly opts: SimOptions;
  readonly belt: SimulatedBelt;
  private device: SimDevice | null = null;

  constructor(opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.belt = new SimulatedBelt(this.opts);
  }

  async availability(): Promise<BleAvailability> { return { ok: true }; }

  async requestDevice(): Promise<BleDevice> {
    this.device = new SimDevice(this.belt, this.opts);
    return this.device;
  }

  /** Connection loss "from outside" (radio gap, treadmill out of range). The belt keeps running. */
  simulateConnectionLoss() { this.device?.disconnect(); }

  /** Safety key pulled: the belt stops immediately. */
  pullSafetyKey() { this.belt.stop('safety-key'); }

  dispose() {
    this.device?.disconnect();
    this.belt.dispose();
  }
}
