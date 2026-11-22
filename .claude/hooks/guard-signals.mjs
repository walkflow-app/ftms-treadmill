#!/usr/bin/env node
// PreToolUse hook for Bash. A local session runs with the maintainer's own GitHub login, so GitHub cannot tell an agent's
// comment from the maintainer's. The PM does the GitHub work (process decision 0012), but the maintainer's steps go out only
// after the maintainer confirms them in the permission dialog:
// - ask: a comment or review whose text is only `approved` or `/hardware-ok` (also from a body file, stdin or JSON),
//   approving a pull request review, merging a pull request, adding the label `agent-ready` (it starts an agent at once),
//   closing an issue or a pull request, and publishing a release;
// - deny: all of these when permissions are bypassed, because then there is no dialog to answer.
// It is one layer, not a proof: a script the agent writes and runs is not checked. The same file is in .claude/hooks/ of
// meta, walkflow, ftms-treadmill and route-store; change them together. Tests (in meta): node --test .claude/hooks/*.test.mjs
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const WRITE = /\bgh\s+(?:issue|pr)\s+(?:comment|create|edit|review|close|reopen)\b|\bgh\s+api\b|\bcurl\b/;
const SIGNAL = /^(?:approved|\/hardware-ok)$/i;
const FLAG = /^.*?(?:^|\s)(?:--body|--raw-field|--field|-b|-f|-F)(?:=|\s+)/;

// A command that runs `rest`: at the start of a line, or after ; & | or $(, and after VAR=value prefixes. Not after a
// backtick: those are mostly Markdown in bodies.
// Text that only mentions the command (in a body) does not count.
const invokes = (command, rest) => new RegExp(String.raw`(?:^|[;&|(])\s*(?:\w+=\S*\s+)*` + rest, 'm').test(command);

const unquote =s => s.trim().replace(/^\$?["'(]+/, '').replace(/(?:\\n)?["')]+$/, '').trim();

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

const CONFIRM = {
  approve: 'Approving a pull request is the maintainer\'s: confirm only if you approve it.',
  signal: 'A comment that is only `approved` or `/hardware-ok` is the maintainer\'s signal (approval of a feature, or the '
    + 'hardware check done): confirm only if you give it.',
  agentReady: '`agent-ready` starts an agent at once: confirm that this task may start now.',
  merge: 'Merging is the maintainer\'s decision: confirm this merge.',
  close: 'Closing an issue or a pull request is the maintainer\'s decision: confirm it.',
  release: 'Publishing a release is the maintainer\'s decision: confirm it (a safety or Bluetooth change only after '
    + '`/hardware-ok`).',
};

/** The verdict for a command: ['ask' | 'deny', reason] or null. `mode` is the session's permission mode. */
export const decide = (command, cwd = process.cwd(), mode = 'default') => {
  const verdict = check(command, cwd);
  if (verdict && mode === 'bypassPermissions') {
    return ['deny', `Permissions are bypassed, so this cannot be confirmed. ${verdict}`];
  }
  return verdict ? ['ask', verdict] : null;
};

const check = (command, cwd) => {
  // Quoted text with spaces is a body or a title: what it says is not run (a GraphQL query is checked on the full command).
  const bare = command.replace(/"(?:[^"\\]|\\.)*"/g, q => (/\s/.test(q) ? q[0] + q[0] : q))
    .replace(/'[^']*'/g, q => (/\s/.test(q) ? q[0] + q[0] : q));
  if (invokes(bare, String.raw`gh\s+pr\s+review\b[^\n]*\s(?:--approve|-a)\b`)) {
    return CONFIRM.approve;
  }
  if (WRITE.test(command)) {
    const texts = [command, ...bodyFiles(command).map(f => read(f, cwd))];
    if (texts.some(t => jsonSignal(t) || t.split('\n').some(signalLine))) {
      return CONFIRM.signal;
    }
    const label = invokes(bare,
      String.raw`gh\s+(?:issue|pr)\s+(?:edit|create)\b[^\n]*\s(?:--add-label|--label|-l)(?:=|\s+)["']?[^\s"']*agent-ready`)
      || invokes(bare, String.raw`gh\s+api\b[^\n]*labels[^\n]*agent-ready`);
    if (label) return CONFIRM.agentReady;
  }
  if (invokes(bare, String.raw`gh\s+pr\s+merge\b`) || invokes(command,
    String.raw`gh\s+api\b[\s\S]*(?:/pulls/\d+/merge\b|mergePullRequest|enablePullRequestAutoMerge)`)) {
    return CONFIRM.merge;
  }
  if (invokes(bare, String.raw`gh\s+(?:issue|pr)\s+close\b`)) return CONFIRM.close;
  if (invokes(bare, String.raw`gh\s+release\s+edit\b[^\n]*--draft(?:=false|\s+false)\b`)
    || (invokes(bare, String.raw`gh\s+release\s+create\b`) && !/\s--draft\b(?!=false)/.test(bare))) return CONFIRM.release;
  return null;
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
