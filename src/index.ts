// ftms-treadmill: controls an FTMS treadmill safely (docs/LIBRARY.md in the walkflow repository). This is the core: pure,
// no DOM, no storage, no texts; it runs in a browser and in Node. The Web Bluetooth adapter, the simulator and the bare
// protocol have entry points of their own.

export {
  createTreadmill,
  type BeltPhase, type Clock, type CommandSource, type EndReason, type RawResult, type Treadmill, type TreadmillEventMap,
  type TreadmillOptions, type TreadmillState,
} from './device/treadmill.ts';
export { WRITE_TIMEOUT_MS, type BleAdapter, type BleAvailability, type BleDevice, type ConnectResult, type Uuid } from './device/ble.ts';
export { STOP_ATTEMPTS, STOP_RETRY_MS } from './device/belt-commands.ts';
export { TreadmillError, type ConsoleBlock, type Notice, type TreadmillErrorCode } from './protocol/notice.ts';
export type { ControlPointResponse, Features, MachineEvent, Range, TreadmillData } from './protocol/ftms.ts';
export {
  DEFAULT_MAX_STEP, DEFAULT_SPEED_LIMIT, LIMIT_CONFIRM_ABOVE, LIMIT_MAX, LIMIT_MIN, MAX_STEP_MAX, MAX_STEP_MIN, parseHexBytes,
  RAMP_INTERVAL_MS,
} from './safety/safety.ts';
export { MOVING_KMH, STANDING_KMH, START_MS, STOP_MAX_MS } from './safety/belt-phase.ts';
export { clampIncline, inclineSupport, type InclineSupport } from './safety/incline.ts';
