// The paths the process distinguishes, in one place: read by the agent pipeline, the safety gate, the release gate and the choice
// of the reviewing model (.github/scripts/review-model.sh). Change a list here and nowhere else (same as walkflow's scripts/paths.mjs).

/** Belt code: what decides what is sent to the treadmill (the promises of docs/LIBRARY.md). Test first, two reviews by two models,
 *  label needs-hardware, one check on a treadmill before the release is published to npm. The pipeline merges it. */
export const SAFETY = [/^src\/safety\//, /^src\/protocol\//, /^src\/device\/(treadmill|belt-commands|ble|reports|belt-state|web-bluetooth)\.ts$/];

/** Trust-boundary code: this library has none (it talks to a treadmill, not to other people). The list exists so the pipeline is the same file as walkflow's. */
export const TRUST = [];

/** The same lists for a shell: `node scripts/paths.mjs safety|trust|careful` prints one extended regular expression. */
// An empty list prints a pattern that matches nothing (an empty one would match every line of a grep)
export const asRegExp = list => (list.length ? list.map(p => p.source.replaceAll('\\/', '/')).join('|') : '$^');

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const lists = { safety: SAFETY, trust: TRUST, careful: [...SAFETY, ...TRUST] };
  const list = lists[process.argv[2]];
  if (!list) { console.error('usage: node scripts/paths.mjs safety|trust|careful'); process.exit(2); }
  console.log(asRegExp(list));
}
