// What is known about the connected treadmill's belt, shared by the parts that send commands (belt-commands.ts) and read what
// the treadmill reports (reports.ts). Plain state; the Treadmill facade (treadmill.ts) owns it.

import type { TreadmillClient } from './ble.ts';
import { beltMaybeRunning } from '../safety/safety.ts';

export class BeltState {
  client: TreadmillClient | null = null;
  /** Started by the app or according to Machine Status, and not stopped since */
  beltStarted = false;
  lastMeasured: number | undefined;
  /** When the speed was last reported (clock of the facade), to tell a fresh reading from an old one */
  lastMeasuredAt = 0;
  /** The treadmill said that control was lost; the next stop asks for control first */
  controlLost = false;

  connected(): boolean { return !!this.client?.connected; }

  /** When in doubt the belt is running (beltMaybeRunning) */
  maybeRunning(): boolean {
    return beltMaybeRunning({ startedByApp: this.beltStarted, lastMeasuredKmh: this.lastMeasured });
  }

  /** Sends a command to the treadmill; false if there is no client or it failed */
  send(bytes: Uint8Array, opts?: { urgent?: boolean }): Promise<boolean> {
    return this.client ? this.client.send(bytes, opts) : Promise.resolve(false);
  }

  /**
   * A new connection: nothing is known about the belt. Call it before the connection is made, not after: the treadmill can
   * report its speed or a started belt while the connection is still being set up, and that must not be forgotten.
   */
  begin(client: TreadmillClient) {
    this.forgetBelt();
    this.client = client;
  }

  /** A new connection or a lost one: nothing is known about the belt */
  forgetBelt() {
    this.beltStarted = false;
    this.lastMeasured = undefined;
    this.controlLost = false;
  }
}
