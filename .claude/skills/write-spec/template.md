# NNNN: Name of the feature

Status: draft
Issue: #…
Repositories: ftms-treadmill (and walkflow, for what the app does with it)

## Problem

Who wants what, and why it matters. One paragraph.

## Scope

What will be built, as a user of the library sees it: the API (names, options, events, notices) with a short example.

## Non-goals

What this deliberately does not do (and might later).

## Acceptance criteria

- [ ] … (test: `src/…/x.test.ts`)
- [ ] … (hardware: HARDWARE-TESTS.md → section …)

## Safety

None / or: what it changes about the speed limit, the ramp, start, stop or warnings, and why that is not weaker than today.
Anything here makes the implementing commits `safety` and is written test first.

## Hardware

What only a treadmill can show, with the expected log lines and bytes (see the `hardware-check` skill in walkflow). "None" if the belt is
not involved.

## Design

Files it touches, entry point (core, /web-bluetooth, /sim, /protocol), whether it is breaking (and why not), whether it
changes a promise in docs/LIBRARY.md. No dependencies.

## Docs

What changes in docs/API.md (with an example), docs/LIBRARY.md and the README, and what the app has to change.

## Open questions

- Question? Proposed answer: …
