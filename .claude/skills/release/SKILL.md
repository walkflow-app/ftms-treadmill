---
name: release
description: Release ftms-treadmill to npm - merge the release-please pull request, check the draft, publish it (which publishes to npm through Trusted Publishing), and bump the version in the Walkflow app. Use when the maintainer says "release" in the ftms-treadmill repository or asks to release the library.
---

# Release ftms-treadmill

How releases work is in [docs/LIBRARY.md → Packaging](../../../docs/LIBRARY.md#packaging). Never run `npm publish` yourself:
publishing the GitHub release runs `npm-publish.yml`, which publishes with provenance and no token.

## 1. The release pull request

```bash
gh pr list --search "chore: release in:title" --state open
gh pr view <n>
```

Check the changelog against `git log v<last>..origin/main --oneline`. Is the version right? A changed promise
(*What the library promises*) or a breaking API change must at least be a minor version.

**Stop and ask before step 3** if the changelog has a *Safety* section or any change to what is sent to the treadmill
(`src/device/treadmill.ts`, `src/device/belt-commands.ts`, `src/safety/`, `src/device/ble.ts`). Such a version is checked on
a real treadmill first: try it in the app (`npm run build` here, `npm link ../ftms-treadmill` in walkflow), and name the
checks from walkflow's HARDWARE-TESTS.md (the `hardware-check` skill there). Wait until the maintainer says they passed.

## 2. Merge and check the draft

```bash
gh pr merge <n> --squash --delete-branch
gh run list -w release-please.yml -L 1 && gh run watch <id> --exit-status
gh release view v<version> --json isDraft,tagName
```

## 3. Publish

```bash
gh release edit v<version> --draft=false --latest
gh run list -w npm-publish.yml -L 1 && gh run watch <id> --exit-status
npm view ftms-treadmill version   # must be the new version (can take a minute)
```

If `npm-publish.yml` fails at the publish step with an auth error, the Trusted Publisher on npmjs.com is missing or wrong;
only the maintainer can fix that. Report it, do not try a token.

## 4. Bring it into the app

In `../walkflow`, on a branch from `main`:

```bash
npm install --save-dev --save-exact ftms-treadmill@<version>
npm run typecheck && npm run lint && npm test
```

Pull request title: `safety(treadmill): ftms-treadmill <version>, <what changed>` if the release has safety changes,
otherwise `build(deps): ftms-treadmill <version>` (or `feat`/`fix` if the app gains or fixes something visible). Update the
app's README, HARDWARE-TESTS.md and docs where the new version changes what they say.
