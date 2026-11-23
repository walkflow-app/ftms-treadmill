// The feature gate (meta decision 0010): a task of a feature is built only when the feature is approved and the task's
// blockers are closed. Approved means a comment on the Feature issue that is only "approved", by an owner named in the
// .github/CODEOWNERS of the feature's repository; agents post as bots, so their comments never count.
//
//   node scripts/feature-gate.mjs approval <owner/repo>#<n>   the approving comment of a feature, or exit 1
//   node scripts/feature-gate.mjs check <n> [--undo]          may this repository's issue be built? With --undo (claude.yml):
//                                                             if not, take `agent-ready` off and say why on the issue
//   node scripts/feature-gate.mjs dispatch [--dry]            start every task here that may start now (dispatch.yml);
//                                                             --dry only says which
//
// A task is a sub-issue of a Feature issue (in any repository); its blockers are its "blocked by" issues. An issue that is
// not part of a feature is the maintainer's own call: only its labels and blockers are checked, and the dispatcher never
// starts it.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { owners } from './release-gate.mjs';

/** Labels that keep a task from being started by an agent */
export const HOLD = ['needs-maintainer', 'stuck', 'hold'];
/** At most this many tasks started by one run of the dispatcher */
export const MAX_START = 3;

// ---------- Pure decisions (tests/feature-gate.test.ts) ----------

const ref = i => `${i.repo}#${i.number}`;

/** The comment that approves a feature: only "approved", by an owner (logins ignore case). comments: [{ user, body, url }] */
export const approval = (comments, who) => {
  const owner = new Set(who.map(w => w.toLowerCase()));
  return comments.find(c => owner.has(c.user?.toLowerCase()) && /^\s*approved\s*$/i.test(c.body ?? '')) ?? null;
};

/**
 * Why a task may not start; [] when it may.
 * task: { repo, number, state, labels, type }; feature: { repo, number, state, type, comments } or null (not part of a feature);
 * blockers: [{ repo, number, state }]; who: the owners in the feature repository's CODEOWNERS.
 */
export function reasons(task, feature, blockers, who) {
  const why = [];
  if (task.state !== 'open') why.push(`${ref(task)} is closed`);
  if (task.type === 'Feature') why.push('it is a Feature issue: its tasks are built, not the feature as one');
  for (const l of HOLD) if (task.labels.includes(l)) why.push(`it is labelled \`${l}\``);
  const open = blockers.filter(b => b.state !== 'closed');
  if (open.length) why.push(`it is blocked by ${open.map(ref).join(', ')}`);
  if (!feature) return why;
  if (feature.type !== 'Feature') why.push(`its parent ${ref(feature)} is not a Feature issue`);
  if (feature.state !== 'open') why.push(`its feature ${ref(feature)} is closed`);
  if (!approval(feature.comments, who)) {
    why.push(`its feature ${ref(feature)} is not approved (a comment that is only "approved", by an owner in CODEOWNERS)`);
  }
  return why;
}

/** Issues the dispatcher looks at: open issues, not pull requests, not started yet, not held */
export const candidates = issues => issues.filter(i =>
  !i.pullRequest && i.state === 'open' && !i.labels.includes('agent-ready') && !i.labels.some(l => HOLD.includes(l)));

// ---------- GitHub ----------

const REPO = process.env.GITHUB_REPOSITORY ?? 'walkflow-app/ftms-treadmill';
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const api = path => JSON.parse(gh(['api', path]) || 'null');
const pages = path => JSON.parse(gh(['api', '--paginate', '--slurp', path])).flat();
/** The API's answer, or null when it is 404 (no parent, no file) */
const maybe = path => {
  try {
    return api(path);
  } catch (e) {
    if (/HTTP 404/.test(String(e.stderr))) return null;
    throw e;
  }
};

const repoOf = i => i.repository_url.split('/').slice(-2).join('/');
const issueOf = i => ({
  repo: repoOf(i), number: i.number, state: i.state, labels: i.labels.map(l => l.name), type: i.type?.name ?? null,
  pullRequest: !!i.pull_request,
});
const comments = (repo, n) => pages(`repos/${repo}/issues/${n}/comments?per_page=100`)
  .map(c => ({ user: c.user?.login, body: c.body, url: c.html_url }));
const ownersCache = new Map();
const ownersOf = repo => {
  if (!ownersCache.has(repo)) {
    ownersCache.set(repo, owners(gh(['api', `repos/${repo}/contents/.github/CODEOWNERS`, '-H', 'Accept: application/vnd.github.raw'])));
  }
  return ownersCache.get(repo);
};
const featureOf = (repo, n) => {
  const p = maybe(`repos/${repo}/issues/${n}/parent`);
  return p && { ...issueOf(p), comments: comments(repoOf(p), p.number) };
};
const blockersOf = (repo, n) => pages(`repos/${repo}/issues/${n}/dependencies/blocked_by?per_page=100`).map(issueOf);

function judge(task) {
  const feature = featureOf(task.repo, task.number);
  return { feature, why: reasons(task, feature, blockersOf(task.repo, task.number), feature ? ownersOf(feature.repo) : []) };
}

function runApproval(target) {
  const [, repo, n] = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(target ?? '') ?? [];
  if (!repo) throw new Error('usage: feature-gate.mjs approval <owner/repo>#<n>');
  const feature = issueOf(api(`repos/${repo}/issues/${n}`));
  const found = approval(comments(repo, n), ownersOf(repo));
  if (feature.type !== 'Feature') console.log(`${repo}#${n} is not a Feature issue.`);
  console.log(found ? `Approved: ${found.url}` : `${repo}#${n} is not approved.`);
  process.exitCode = found && feature.type === 'Feature' ? 0 : 1;
}

function runCheck(n, undo) {
  if (!/^\d+$/.test(n ?? '')) throw new Error('usage: feature-gate.mjs check <n> [--undo]');
  const task = issueOf(api(`repos/${REPO}/issues/${n}`));
  const { feature, why } = judge(task);
  if (!why.length) {
    console.log(`#${n} may be built${feature ? ` (feature ${ref(feature)} approved, blockers closed)` : ''}.`);
    return;
  }
  for (const w of why) console.log(`::error::#${n}: ${w}`);
  process.exitCode = 1;
  // One comment each time the label is taken off, not on every run
  if (!undo || !task.labels.includes('agent-ready')) return;
  gh(['issue', 'edit', n, '-R', REPO, '--remove-label', 'agent-ready']);
  gh(['issue', 'comment', n, '-R', REPO, '--body',
    `Not started: ${why.join('; ')}. A task of a feature is started by dispatch.yml once that changes.`]);
}

function runDispatch(dry) {
  const open = candidates(pages(`repos/${REPO}/issues?state=open&per_page=100`).map(issueOf));
  let started = 0;
  for (const task of open) {
    const { feature, why } = judge(task);
    if (!feature) continue;
    if (why.length) {
      console.log(`#${task.number} waits: ${why.join('; ')}`);
      continue;
    }
    if (started >= MAX_START) {
      console.log(`#${task.number} may start, at the next run (at most ${MAX_START} per run)`);
      continue;
    }
    if (dry) {
      console.log(`#${task.number} would start (feature ${ref(feature)})`);
      started++;
      continue;
    }
    // The label is only a marker (an event of the workflow token starts no workflow); workflow_dispatch starts the build
    gh(['issue', 'edit', String(task.number), '-R', REPO, '--add-label', 'agent-ready']);
    try {
      gh(['workflow', 'run', 'claude.yml', '-R', REPO, '-f', `issue=${task.number}`]);
    } catch (e) {
      // Without the marker the next run tries again
      gh(['issue', 'edit', String(task.number), '-R', REPO, '--remove-label', 'agent-ready']);
      console.log(`::error::#${task.number} not started: ${String(e.stderr ?? e.message).trim()}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`#${task.number} started (feature ${ref(feature)})`);
    started++;
  }
  console.log(`${open.length} open issues looked at, ${started} started.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [mode, arg, flag] = process.argv.slice(2);
  if (mode === 'approval') runApproval(arg);
  else if (mode === 'check') runCheck(arg, flag === '--undo');
  else if (mode === 'dispatch') runDispatch(arg === '--dry');
  else throw new Error('usage: feature-gate.mjs approval <owner/repo>#<n> | check <n> [--undo] | dispatch [--dry]');
}
