import { describe, expect, it } from 'vitest';
// @ts-expect-error plain script without types, also run by node in CI
import { approval, candidates, HOLD, reasons } from '../scripts/feature-gate.mjs';

const who = ['caenderl'];
const ok = { user: 'caenderl', body: 'approved', url: 'https://github.com/walkflow-app/walkflow/issues/74#issuecomment-1' };
const task = (labels: string[] = [], state = 'open') => ({ repo: 'walkflow-app/walkflow', number: 80, state, labels });
const feature = (comments = [ok], type = 'Feature', state = 'open') => ({ repo: 'walkflow-app/walkflow', number: 74, state, type, comments });
const blocker = (state: string, number = 79, repo = 'walkflow-app/ftms-treadmill') => ({ repo, number, state });

describe('feature gate', () => {
  it('finds the approval: only "approved", by an owner', () => {
    expect(approval([ok], who)).toBe(ok);
    expect(approval([{ ...ok, body: '  Approved\n' }], who)).not.toBeNull();
    expect(approval([{ ...ok, user: 'CAenderl' }], who)).not.toBeNull();
    expect(approval([{ ...ok, user: 'someone' }], who)).toBeNull();
    expect(approval([{ ...ok, user: 'walkflow-writer[bot]' }], who)).toBeNull();
    expect(approval([{ ...ok, body: 'approved, but change the name first' }], who)).toBeNull();
    expect(approval([{ ...ok, body: 'not approved' }], who)).toBeNull();
    expect(approval([{ ...ok, body: '> approved\n\nQuoted.' }], who)).toBeNull();
  });

  it('lets a task of an approved feature start when its blockers are closed', () => {
    expect(reasons(task(), feature(), [blocker('closed')], who)).toEqual([]);
    expect(reasons(task(['needs-hardware']), feature(), [], who)).toEqual([]);
  });

  it('holds a task of a feature that is not approved, closed or not a feature', () => {
    expect(reasons(task(), feature([]), [], who).join()).toMatch(/not approved/);
    expect(reasons(task(), feature([{ ...ok, user: 'someone' }]), [], who).join()).toMatch(/not approved/);
    expect(reasons(task(), feature([ok], 'Task'), [], who).join()).toMatch(/not a Feature issue/);
    expect(reasons(task(), feature([ok], 'Feature', 'closed'), [], who).join()).toMatch(/feature .* is closed/);
  });

  it('holds a task with an open blocker, in any repository', () => {
    expect(reasons(task(), feature(), [blocker('closed'), blocker('open')], who)).toEqual([
      'it is blocked by walkflow-app/ftms-treadmill#79',
    ]);
  });

  it('holds needs-maintainer, stuck and hold, and closed tasks, but not belt code (meta process/flow.md)', () => {
    for (const l of HOLD) expect(reasons(task([l]), feature(), [], who)).toEqual([`it is labelled \`${l}\``]);
    expect(reasons(task(['safety']), feature(), [], who)).toEqual([]);
    expect(reasons(task([], 'closed'), feature(), [], who).join()).toMatch(/is closed/);
    expect(reasons({ ...task(), type: 'Feature' }, null, [], who).join()).toMatch(/Feature issue/);
  });

  it('checks only labels and blockers of an issue outside a feature', () => {
    expect(reasons(task(), null, [], who)).toEqual([]);
    expect(reasons(task(['hold']), null, [blocker('open')], who)).toHaveLength(2);
  });

  it('looks only at open issues that are not started or held', () => {
    const issue = (number: number, labels: string[] = [], extra = {}) => ({ number, state: 'open', labels, pullRequest: false, ...extra });
    expect(candidates([
      issue(1), issue(2, ['agent-ready']), issue(3, ['stuck']), issue(4, [], { pullRequest: true }),
      issue(5, [], { state: 'closed' }), issue(6, ['needs-hardware']),
    ]).map((i: { number: number }) => i.number)).toEqual([1, 6]);
  });
});
