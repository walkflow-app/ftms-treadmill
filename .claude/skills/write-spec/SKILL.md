---
name: write-spec
description: Turn an idea or issue for the library into a spec in docs/specs/ before anything is built - the API it adds, acceptance criteria that become tests, whether a promise or the API breaks, hardware checks. Use when a new feature or API change for ftms-treadmill is asked for, or when "spec" is said.
---

# Write a spec for the library

The API is a contract, so it is decided before it is built. Code starts only when the spec says `Status: accepted`, which
only the maintainer sets.

1. Read [docs/LIBRARY.md](../../../docs/LIBRARY.md) (design, promises), [docs/API.md](../../../docs/API.md) and the code it touches.
   Look at how Walkflow (`../walkflow`) would use it: the library exists for the app first.
2. Copy [template.md](template.md) to `docs/specs/NNNN-short-name.md` (next free four-digit number) and fill it in. Show the
   API as a short `ts` example. Prefer what can stay as it is after 1.0: no option that will have to break later, a
   `source`-like field instead of a boolean flag when there may be more cases.
3. Every acceptance criterion names its test, or the HARDWARE-TESTS.md item in walkflow for what only a treadmill shows.
4. Open questions go into the spec with a proposed answer.
5. Pull request with only the spec, title `docs(spec): <name>`. When it is built, the implementing pull request sets the
   status to `done`.

Statuses: `draft` → `accepted` → `in progress` → `done`, or `dropped` (keep the file, say why).
