import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const temp = useTempDir('approval-learning-');
function runtime(policy?: string) {
  const root = temp();
  if (policy) fs.writeFileSync(path.join(root, 'policy.yaml'), policy);
  const value = new TrustedAgentApprovalRuntime(
    path.join(root, 'policy.yaml'),
    path.join(root, 'agent.json'),
    path.join(root, 'all.json'),
    path.join(root, 'legacy.json'),
    undefined,
    path.join(root, 'pending.json'),
  );
  value.setSession('test-session');
  value.setApprovalMode({ mode: 'learning' });
  return value;
}
const call = (toolName: string, args: Record<string, unknown>) => ({
  toolName,
  argsJson: JSON.stringify(args),
  latestUserPrompt: 'Prepare the report.',
});

test.each([
  ['read', { path: '.env' }, 'required', true],
  ['write', { path: '.env', contents: 'SAMPLE=test-value' }, 'required', true],
  ['write', { path: 'reports/new.txt', contents: 'report' }, 'implicit', false],
] as const)(
  'observes %s without prompting, waiting, or granting trust',
  (tool, args, decision, pinned) => {
    const policy = runtime();
    const input = call(tool, args);
    const first = policy.evaluateToolCall(input);
    expect(first).toMatchObject({
      decision: 'auto',
      escalationRoute: 'none',
      approvalObservation: { decision, pinned },
    });
    expect(first.requestId).toBeUndefined();
    expect(first.implicitDelayMs).toBeUndefined();
    expect(policy.getPendingApprovals()).toEqual([]);
    policy.afterToolExecution(first, true);
    expect(policy.evaluateToolCall(input).approvalObservation).toEqual(
      first.approvalObservation,
    );
    policy.setApprovalMode({ mode: 'auto' });
    expect(policy.evaluateToolCall(input).decision).toBe(decision);
  },
);

test('ordinary reads do not fabricate approval flags', () => {
  expect(
    runtime().evaluateToolCall(call('read', { path: 'README.md' }))
      .approvalObservation,
  ).toBeUndefined();
});

test('explicit network deny remains a denial in learning mode', () => {
  const policy = runtime(
    'network:\n  rules:\n    - action: deny\n      host: blocked.example\n',
  );
  const result = policy.evaluateToolCall(
    call('web_fetch', { url: 'https://blocked.example' }),
  );
  expect(result.decision).toBe('denied');
  expect(result.approvalObservation).toBeUndefined();
  expect(policy.getPendingApprovals()).toEqual([]);
});

test('an existing pending prompt neither fills the learning queue nor becomes consent', () => {
  const policy = runtime('approval:\n  max_pending_approvals: 1\n');
  policy.setApprovalMode({ mode: 'auto' });
  const pending = policy.evaluateToolCall(call('read', { path: '.env' }));
  expect(pending.decision).toBe('required');
  policy.setApprovalMode({ mode: 'learning' });
  expect(
    policy.evaluateToolCall(call('read', { path: '.env.other' }))
      .approvalObservation?.decision,
  ).toBe('required');
  expect(policy.getPendingApprovals().map((item) => item.id)).toEqual([
    pending.requestId,
  ]);
});
