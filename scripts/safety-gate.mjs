// The safety gate of a pull request (CI job `safety-gate`, see README → Develop): code that decides what is sent to the
// treadmill changes only together with a test, and says so. A missing test fails the check; a title that is not `safety` and
// the reminder of the treadmill checks are warnings, because a refactor of safety code is not a safety change.
//
//   node scripts/safety-gate.mjs <base ref> "<pull request title>"
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Code that decides what is sent to the belt, and the promises of docs/LIBRARY.md
const SAFETY = [/^src\/safety\//, /^src\/protocol\//, /^src\/device\/(treadmill|belt-commands|ble|reports|belt-state)\.ts$/];
const TEST = /\.test\.ts$/;

export function checkSafetyGate({ files, title }) {
  const errors = [], warnings = [];
  const safety = files.filter(f => SAFETY.some(p => p.test(f)) && !TEST.test(f));
  const tests = files.filter(f => TEST.test(f));
  const isSafetyTitle = /^safety(\(.+\))?!?:/.test(title);
  if (safety.length && !tests.length)
    errors.push(`Safety code changed without a changed test: ${safety.join(', ')}. Write the test first (README → Develop).`);
  if (safety.length && !isSafetyTitle)
    warnings.push(`Safety code changed but the title is not "safety(…)": fine for a refactor that changes no behaviour, otherwise use the safety type.`);
  if (safety.length || isSafetyTitle)
    warnings.push("Name in the pull request what has to be checked on a treadmill (walkflow's HARDWARE-TESTS.md) before a release with this change is published.");
  return { errors, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base = 'origin/main', title = ''] = process.argv.slice(2);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
  const files = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const { errors, warnings } = checkSafetyGate({ files, title });
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);
  console.log(errors.length ? 'Safety gate: failed' : 'Safety gate: passed');
  process.exitCode = errors.length ? 1 : 0;
}
