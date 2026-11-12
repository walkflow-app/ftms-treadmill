// The adapter for Web Bluetooth (browsers, Electron): the only place that touches navigator.bluetooth. Its own entry point
// (ftms-treadmill/web-bluetooth), so that the core runs without a browser.

/// <reference types="web-bluetooth" />
import { TreadmillError } from '../protocol/notice.ts';
import type { BleAdapter, BleAvailability, BleDevice, Uuid } from './ble.ts';

class WebBluetoothDevice implements BleDevice {
  private server: BluetoothRemoteGATTServer | null = null;
  private services = new Map<Uuid, Promise<BluetoothRemoteGATTService>>();
  private chars = new Map<string, Promise<BluetoothRemoteGATTCharacteristic>>();
  private listeners: [BluetoothRemoteGATTCharacteristic, EventListener][] = [];
  private disconnectCb: (() => void) | null = null;
  private readonly handleDisconnect = () => {
    this.dev.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    for (const [c, l] of this.listeners) c.removeEventListener('characteristicvaluechanged', l);
    this.listeners = [];
    this.services.clear();
    this.chars.clear();
    const cb = this.disconnectCb;
    this.disconnectCb = null;
    cb?.();
  };

  constructor(private readonly dev: BluetoothDevice) {}

  get name() { return this.dev.name; }
  get connected() { return !!this.dev.gatt?.connected; }

  async connect() {
    if (!this.dev.gatt) throw new TreadmillError('no-gatt');
    this.dev.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.server = await this.dev.gatt.connect();
  }

  disconnect() {
    this.dev.gatt?.disconnect();
  }

  onDisconnected(cb: () => void) {
    this.disconnectCb = cb;
  }

  private service(uuid: Uuid) {
    let s = this.services.get(uuid);
    if (!s) {
      if (!this.server) return Promise.reject(new TreadmillError('not-connected'));
      s = this.server.getPrimaryService(uuid);
      s.catch(() => this.services.delete(uuid));
      this.services.set(uuid, s);
    }
    return s;
  }

  private characteristic(service: Uuid, characteristic: Uuid) {
    const key = `${service}/${characteristic}`;
    let c = this.chars.get(key);
    if (!c) {
      c = this.service(service).then(s => s.getCharacteristic(characteristic));
      c.catch(() => this.chars.delete(key));
      this.chars.set(key, c);
    }
    return c;
  }

  async read(service: Uuid, characteristic: Uuid) {
    return (await this.characteristic(service, characteristic)).readValue();
  }

  async subscribe(service: Uuid, characteristic: Uuid, cb: (dv: DataView) => void) {
    const c = await this.characteristic(service, characteristic);
    const l: EventListener = ev => {
      const v = (ev.target as BluetoothRemoteGATTCharacteristic).value;
      if (v) cb(v);
    };
    c.addEventListener('characteristicvaluechanged', l);
    this.listeners.push([c, l]);
    await c.startNotifications();
  }

  async write(service: Uuid, characteristic: Uuid, data: Uint8Array) {
    const c = await this.characteristic(service, characteristic);
    const buf = data.slice().buffer;
    if (c.writeValueWithResponse) await c.writeValueWithResponse(buf);
    else await c.writeValue(buf);
  }
}

export class WebBluetoothAdapter implements BleAdapter {
  readonly kind = 'web-bluetooth';

  async availability(): Promise<BleAvailability> {
    if (typeof navigator === 'undefined' || !navigator.bluetooth) return { ok: false, reason: 'no-api' };
    try {
      if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability())) {
        return { ok: false, reason: 'no-adapter' };
      }
    } catch {
      // getAvailability is optional; when in doubt, carry on
    }
    return { ok: true };
  }

  async requestDevice(optionalServices: Uuid[]): Promise<BleDevice> {
    // No service filter: unclear whether the treadmill advertises 0x1826.
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices });
    return new WebBluetoothDevice(dev);
  }
}
