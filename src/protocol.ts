// ftms-treadmill/protocol: the FTMS parsers and commands alone (GATT UUIDs, Treadmill Data, Machine Status, Control Point),
// for anyone who drives the bytes themselves. Nothing here keeps a belt safe; createTreadmill does.

export * from './protocol/ftms.ts';
