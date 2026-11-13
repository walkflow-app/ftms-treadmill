# ftms-treadmill: notes for agents

This library decides what is sent to a real treadmill that a person is standing on. Read [README.md](README.md),
[docs/LIBRARY.md](docs/LIBRARY.md) (design, the promises, packaging, releases) and [docs/API.md](docs/API.md) before changing
code; this file only adds what an agent tends to miss.

## Where it is used

The app [walkflow-app/walkflow](https://github.com/walkflow-app/walkflow) (cloned next to this repository as `../walkflow`)
pins an exact version from npm. A change here reaches the app only after a release and a version bump there. To try it in
the app first: `npm run build` here, `npm link ../ftms-treadmill` in the app.

## Rules

- **The promises in docs/LIBRARY.md → *What the library promises* are the contract.** Each has a test. Code that decides what
  is sent (`src/device/treadmill.ts`, `src/device/belt-commands.ts`, `src/safety/`) changes **test first**, and must not
  weaken a limit, a delay or a stop. Changing a promise is a `safety` commit and at least a minor version.
- **The API is a contract too.** Avoid options and names that would have to break later; when unsure, propose in an issue
  or a pull request description before building. Every public change goes into docs/API.md with an example
  (`npm run check:docs` compiles them).
- **You cannot test Bluetooth.** For a change that touches the treadmill, say exactly what to check in the log (hex bytes,
  expected lines). A release with such a change is checked on a real treadmill before it is published.
- **No dependencies.** `tests/architecture.test.ts` enforces the entry points and that nothing outside `src/` is imported.
  Dev-only types the code needs (e.g. `@types/web-bluetooth`) are devDependencies of this repository.
- **English** everywhere in the repository.

## Commands

```bash
npm ci
npm run typecheck && npm run lint && npm test && npm run build   # what CI runs
npm run check:docs                                               # every ts example in README.md and docs/API.md compiles
npm run example                                                  # drives the simulator from start to stop
```

## Commits, pull requests, releases

- One branch and one pull request per change, from `main`; avoid stacked pull requests. The title becomes the squash commit
  and must be a Conventional Commit (`safety`, `feat`, `fix`, …); release-please makes the version and the changelog from it.
- `main` takes changes only through pull requests with CI (`test`) green.
- Merging the release pull request creates the tag `v<version>` and a draft release. Publishing the draft runs
  `npm-publish.yml`, which publishes through npm Trusted Publishing (no token). Ask the maintainer before publishing a draft
  that contains `safety` or Bluetooth changes.

## Never without being asked

Run `npm publish`, force-push, merge with `--admin`, change repository settings, rulesets, secrets or the Trusted Publisher,
or delete releases, tags or branches other than your own.
