// What the examples in the documentation take as given (scripts/check-docs.mjs): a treadmill and an adapter.
import type { BleAdapter, Treadmill } from '../src/index.ts';

declare global {
  /** A treadmill made with createTreadmill() and connected */
  const tm: Treadmill;
  /** Any adapter: WebBluetoothAdapter, SimulatorAdapter or your own */
  const adapter: BleAdapter;
}
