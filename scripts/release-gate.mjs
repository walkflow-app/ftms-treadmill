// The release gate (meta spec 0002): agents may merge changes that reach the belt, so a release waits until the maintainer
// has checked them on a treadmill. Every pull request merged since the last release that touches a safety path (see agent-pipeline.mjs), or has the label needs-hardware, needs a comment that is only the line
// "/hardware-ok", written after its merge by an owner named in .github/CODEOWNERS; or one such comment on the release pull
// request, written after the last of them was merged, for all. Run by the release skill before the release pull request is
// merged, and by npm-publish.yml before anything is published (a failed run is run again after the comment).
//
//   node scripts/release-gate.mjs <ref> [<release pull request>]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classify } from './agent-pipeline.mjs';

/** The owners of everything (the line "*" of CODEOWNERS), without "@" */
export const owners = codeowners => (/^\*\s+(.+)$/m.exec(codeowners)?.[1] ?? '').split(/\s+/).filter(Boolean).map(o => o.replace(/^@/, ''));

/** A comment that confirms the hardware checks: "/hardware-ok" alone on a line, by an owner, after `after` (ISO time) */
export const confirms = (c, who, after) => who.includes(c.user) && /^\/hardware-ok\s*$/m.test(c.body ?? '') && c.createdAt > after;

/** The pull requests that still wait for the hardware checks. prs: [{ number, title, files, labels, comments, mergedAt }] */
export function releaseGate(prs, releaseComments, who) {
  const needs = prs.filter(p => classify(p.files).safety || p.labels.includes('needs-hardware'));
  const lastMerge = needs.map(p => p.mergedAt).toSorted().at(-1) ?? '';
  if (releaseComments.some(c => confirms(c, who, lastMerge))) return [];
  return needs.filter(p => !p.comments.some(c => confirms(c, who, p.mergedAt)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [ref = 'HEAD', releasePr] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY ?? 'walkflow-app/ftms-treadmill';
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const pages = path => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 64 << 20 })).flat();
  const comments = n => pages(`repos/${repo}/issues/${n}/comments?per_page=100`).map(c => ({ user: c.user?.login, body: c.body, createdAt: c.created_at }));
  const who = owners(git('show', `${ref}:.github/CODEOWNERS`));
  if (!who.length) throw new Error('.github/CODEOWNERS names no owner for "*"');
  // The last release before <ref> (its tag itself when <ref> is the new tag)
  const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*', `${ref}^`);
  const numbers = git('log', '--format=%s', `${last}..${ref}`).split('\n').map(s => /\(#(\d+)\)$/.exec(s)?.[1]).filter(Boolean);
  // The release pull request: given, or the one that made <ref>
  const rel = releasePr || api(`repos/${repo}/commits/${git('rev-parse', ref)}/pulls`)[0]?.number.toString();
  const prs = numbers.filter(n => n !== rel).map(n => {
    const p = api(`repos/${repo}/pulls/${n}`);
    return {
      number: n, title: p.title, labels: p.labels.map(l => l.name), mergedAt: p.merged_at ?? '',
      files: pages(`repos/${repo}/pulls/${n}/files?per_page=100`), comments: comments(n),
    };
  });
  const open = releaseGate(prs, rel ? comments(rel) : [], who);
  console.log(`Since ${last}: ${prs.length} pull requests, ${open.length} waiting for the hardware checks.`);
  for (const p of open) console.log(`::error::#${p.number} ${p.title}: run its checks (written in the pull request, collected in walkflow's HARDWARE-TESTS.md) on a treadmill, then comment "/hardware-ok" on it (or once on the release pull request for all) and re-run this job.`);
  process.exitCode = open.length ? 1 : 0;
}
