#!/usr/bin/env node
// PreToolUse hook for Bash. A local session runs with the maintainer's own GitHub login, so GitHub cannot tell an agent's
// comment from the maintainer's. The PM does the GitHub work (process decision 0012), but what only a person can say goes
// out only after the maintainer confirms it in the permission dialog:
// - ask: a comment or review whose text is only `approved` or `/hardware-ok` (also from a body file, stdin or JSON),
//   publishing a release, and removing the label `needs-maintainer` or `hold`;
// - ask: a push that is not `git push [-u] origin <one branch>` (the allow list lets that one pass, nothing else), and
//   `gh workflow run` on another ref;
// - not asked (principles 1, 5 and 6; the maintainer, 2026-11-25): `agent-ready`, closing an issue or a pull request,
//   approving a review, and **any merge**. A pull request on the stop list (`needs-maintainer`, `hold`, belt code, the
//   rules themselves) is merged by a session only when the maintainer said so in the session ("merge #N"): that word is the
//   confirmation, and a dialog on top of it only costs time;
// - deny: all of the asks when permissions are bypassed, because then there is no dialog to answer.
// It is one layer, not a proof: a script the agent writes and runs is not checked. The same file is in .claude/hooks/ of
// meta, walkflow, ftms-treadmill and route-store; meta first, the others follow, then change them together.
// Tests (in meta): node --test .claude/hooks/*.test.mjs
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const WRITE = /\bgh\s+(?:issue|pr)\s+(?:comment|create|edit|review|close|reopen)\b|\bgh\s+api\b|\bcurl\b/;
const SIGNAL = /^(?:approved|\/hardware-ok)$/i;
const FLAG = /^.*?(?:^|\s)(?:--body|--raw-field|--field|-b|-f|-F)(?:=|\s+)/;

// A command that runs `rest`: at the start of a line, or after ; & | or $(, and after VAR=value prefixes. Not after a
// backtick: those are mostly Markdown in bodies.
// Text that only mentions the command (in a body) does not count.
const invokes = (command, rest) => new RegExp(String.raw`(?:^|[;&|(])\s*(?:\w+=\S*\s+)*` + rest, 'm').test(command);

const unquote = s => s.trim().replace(/^\$?["'(]+/, '').replace(/(?:\\n)?["')]+$/, '').trim();

// Quoted text with spaces is a body or a title: what it says is not run.
const bareOf = command => command.replace(/"(?:[^"\\]|\\.)*"/g, q => (/\s/.test(q) ? q[0] + q[0] : q))
  .replace(/'[^']*'/g, q => (/\s/.test(q) ? q[0] + q[0] : q));

// A line that is nothing but a signal, after a body flag, a key= and quotes are taken off.
export const signalLine = line => {
  const parts = /\b(?:echo|printf)\b/.test(line) ? line.split(/\|\||&&|[|;]/) : [line];
  return parts.some(part => {
    let s = part.trim().replace(/^(?:echo|printf)(?:\s+-\w+)*\s+/, '').replace(FLAG, '');
    s = unquote(s).replace(/^[\w[\]]+=/, '');
    return SIGNAL.test(unquote(s));
  });
};

const jsonSignal = text => /"body"\s*:\s*"\s*(?:approved|\/hardware-ok)\s*(?:\\n)?\s*"/i.test(text);

// Files the command sends as a body: --body-file f, -F f (gh issue/pr), --input f, key=@f.
export const bodyFiles = command => {
  const files = [];
  for (const m of command.matchAll(/(?:--body-file|--input|-F)(?:=|\s+)(["']?)([^\s"']+)\1/g)) files.push(m[2]);
  for (const m of command.matchAll(/=@(["']?)([^\s"']+)\1/g)) files.push(m[2]);
  return files.filter(f => f !== '-' && !/^[\w[\]]+=/.test(f));
};

const read = (file, cwd) => {
  try {
    const path = resolve(cwd, file.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
    return statSync(path).size < 1_000_000 ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
};

const PUSH = /(?:^|[;&|(])\s*(?:\w+=\S*\s+)*git\s+push\b([^\n;&|)]*)/gm;

/** True when a push in the command is anything but `[-u|--set-upstream] origin <one plain branch>`. */
const pushRisk = bare => [...bare.matchAll(PUSH)].some(([, args]) => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const flags = tokens.filter(t => t.startsWith('-'));
  const refs = tokens.filter(t => !t.startsWith('-'));
  return flags.some(f => f !== '-u' && f !== '--set-upstream') || refs.length !== 2 || refs[0] !== 'origin'
    || /[:+]|^(?:main|master|HEAD)$|^refs\//.test(refs[1]);
});

const CONFIRM = {
  signal: 'A comment that is only `approved` or `/hardware-ok` is the maintainer\'s signal (approval of a feature, or the '
    + 'hardware check done): confirm only if you give it.',
  label: 'Removing `needs-maintainer` or `hold` decides a stop-list item: confirm it.',
  push: 'Only a plain push of one branch to origin goes without a question: this push names more, forces, deletes or '
    + 'reaches main. Confirm it.',
  workflow: 'Running a workflow on another ref runs the code of that branch with the repository\'s secrets: confirm it.',
  release: 'Publishing a release is the maintainer\'s decision: confirm it (a safety or Bluetooth change only after '
    + '`/hardware-ok`).',
};

const check = (command, cwd) => {
  const bare = bareOf(command);
  if (WRITE.test(command)) {
    const texts = [command, ...bodyFiles(command).map(f => read(f, cwd))];
    if (texts.some(t => jsonSignal(t) || t.split('\n').some(signalLine))) {
      return CONFIRM.signal;
    }
  }
  if (invokes(command, String.raw`gh\s+(?:issue|pr)\s+edit\b[^\n]*--remove-label(?:=|\s+)[^\n]*\b(?:needs-maintainer|hold)\b`)) {
    return CONFIRM.label;
  }
  if (pushRisk(bare)) return CONFIRM.push;
  if (invokes(bare, String.raw`gh\s+workflow\s+run\b[^\n]*\s(?:--ref|-r)\b`)) return CONFIRM.workflow;
  if (invokes(bare, String.raw`gh\s+release\s+edit\b[^\n]*--draft(?:=false|\s+false)\b`)
    || (invokes(bare, String.raw`gh\s+release\s+create\b`) && !/\s--draft\b(?!=false)/.test(bare))) return CONFIRM.release;
  return null;
};

/** The verdict for a command: ['ask' | 'deny', reason] or null. `mode` is the session's permission mode. */
export const decide = (command, cwd = process.cwd(), mode = 'default') => {
  const verdict = check(command, cwd);
  if (verdict && mode === 'bypassPermissions') {
    return ['deny', `Permissions are bypassed, so this cannot be confirmed. ${verdict}`];
  }
  return verdict ? ['ask', verdict] : null;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { tool_name: tool, tool_input: { command = '' } = {}, cwd, permission_mode: mode } = JSON.parse(input || '{}');
  const verdict = tool === 'Bash' ? decide(command, cwd, mode) : null;
  if (verdict) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict[0],
        permissionDecisionReason: verdict[1],
      },
    }));
  }
}
