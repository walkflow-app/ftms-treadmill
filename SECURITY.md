# Security policy

ftms-treadmill decides what is sent to a treadmill that a person is standing on, so the problems taken most seriously are
**anything that breaks one of the library's promises**
([README → What it promises](README.md#what-it-promises), in full in
[docs/LIBRARY.md](docs/LIBRARY.md#what-the-library-promises)): a speed above the limit or a bigger step than allowed (also
through `sendRaw`), a Start that runs the belt up to an old speed, a Stop or Pause that is held back, dropped or not
retried, a missing `ended`, or a method that throws during a session. Also: bytes from a treadmill (or something posing as
one) that make the library crash, hang or believe a wrong belt state, and anything in the published npm package that is not
built from this repository.

## Reporting a problem

Please do not open a public issue for these. Use **Security → Report a vulnerability** on the
[repository page](https://github.com/walkflow-app/ftms-treadmill/security/advisories/new): it is private and reaches the
maintainer directly. Say what you did, what you expected and what happened; for the belt, the treadmill model, the
version of the library and the bytes that were sent and received help most.

This is a project run by one person in their free time, so there is no promised response time. A report is read, and a
confirmed problem in the safety logic is fixed before anything else. The fix is released first; then the advisory is
published, so that `npm audit` and Dependabot warn everyone who installed an affected version.

## What is supported

The latest version on npm. Fixes are made on `main` and released from there; there are no patch releases for older
versions.

## What is not a security problem

- The library cannot stop the belt when the Bluetooth connection is lost. This is how Bluetooth works; the stop button on
  the treadmill and the safety key are what help then.
- The limits (`speedLimit`, `maxStep`, `limitConfirmed`) are set by the app that uses the library. They protect from a slip,
  not from the app or the person who owns the treadmill.
- `sendRaw` sends opcodes that are not blocked on purpose; that it does is documented in [docs/API.md](docs/API.md#raw-commands).
  It sending something above the limit, or a blocked opcode, is a security problem.
