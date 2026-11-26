# Roadmap

What is being done on `ftms-treadmill`, what comes next, and what may come later. The maintainer decides what moves into
*Now*. The app that uses it has [its own roadmap](https://github.com/walkflow-app/walkflow/blob/main/ROADMAP.md). Last updated:
2026-11-26.

State: [0.4.0](https://github.com/walkflow-app/ftms-treadmill/releases/tag/v0.4.0) on npm; Walkflow 0.8.1 uses it. Checked on a
Sportstech sPad 500 (2026-11-25).

## Now

Nothing in progress.

## Next

- **Left over from the belt bugs session** (2026-11-25): the countdown hold does not engage after a start from the app ([#66](https://github.com/walkflow-app/ftms-treadmill/issues/66)); a coast-down longer than the 10 s window can fail a `start()` ([#62](https://github.com/walkflow-app/ftms-treadmill/issues/62)); a lowered limit during the hold waits up to 8 s ([#65](https://github.com/walkflow-app/ftms-treadmill/issues/65)). `safety` `needs-hardware`
- **Standstill watched for every speed**, not only for programs ([docs/LIBRARY.md → Standstill](docs/LIBRARY.md#standstill)).
  A `safety` change of its own, test first, checked on a treadmill; the app does not have to change. `safety` `needs-hardware`
- **Recorded treadmill logs as tests:** logs from a real treadmill replayed against the library, so changes are tested against
  real device behaviour, not only the simulator.

## Later, maybe

- **1.0**, once the API has been used for a while.

## Done recently

- 2026-11-26: 0.4.0 (`safety`, breaking), the belt bugs of [walkflow#111](https://github.com/walkflow-app/walkflow/issues/111): no ramp base from one implausible reading, nothing sent while the belt coasts down or during the start countdown, no Start without a start speed or on a moving belt, a Stop that Start cannot overtake. Checked on a treadmill 2026-11-25.
- 2026-11-22: 0.3.0 (`safety`): raw commands are checked, smaller promise gaps closed.
- 2026-11-13: 0.1.2 from its own repository, published through npm Trusted Publishing; 0.2.0 (`safety`, breaking): `ended`
  comes once per run of the belt; 0.2.1.
- 2026-11-12: 0.1.0, the treadmill control of Walkflow as a library.
