# Roadmap

What is being done on `ftms-treadmill`, what comes next, and what may come later. The maintainer decides what moves into
*Now*. The app that uses it has [its own roadmap](https://github.com/walkflow-app/walkflow/blob/main/ROADMAP.md). Last updated:
2026-11-14.

State: [0.2.1](https://github.com/walkflow-app/ftms-treadmill/releases) on npm; Walkflow 0.7.1 uses 0.2.0. Checked on a
Sportstech sPad 500.

## Now

Nothing in progress.

## Next

- **Standstill watched for every speed**, not only for programs ([docs/LIBRARY.md → Standstill](docs/LIBRARY.md#standstill)).
  A `safety` change of its own, test first, checked on a treadmill; the app does not have to change. `safety` `needs-hardware`
- **Recorded treadmill logs as tests:** logs from a real treadmill replayed against the library, so changes are tested against
  real device behaviour, not only the simulator.

## Later, maybe

- **1.0**, once the API has been used for a while.

## Done recently

- 2026-11-13: 0.2.0 and 0.2.1: `ended` comes once per run of the belt; own repository, published through npm Trusted Publishing.
- 2026-11-12: 0.1.0, the treadmill control of Walkflow as a library.
