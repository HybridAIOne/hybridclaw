import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { parseTuiApprovalPrompt } from '../src/tui-approval.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir('approval-reasons-');
function runtime(policy?: string) {
  const root = tempDir();
  const pending = path.join(root, 'pending.json');
  const policyPath = path.join(root, 'policy.yaml');
  if (policy) fs.writeFileSync(policyPath, policy);
  const instance = new TrustedAgentApprovalRuntime(
    policyPath,
    path.join(root, 'agent.json'),
    path.join(root, 'all.json'),
    path.join(root, 'legacy.json'),
    undefined,
    pending,
  );
  instance.setApprovalMode({ mode: 'full' });
  return { instance, pending };
}

test.each([
  ['read', { path: '.env' }],
  ['bash', { command: 'cat /etc/environment' }],
  ['bash', { command: 'cat /etc/environment && inspect_unknown_format' }],
  ['bash', { command: 'git push --force origin main' }],
] as const)(
  'explains policy pinning for %s %j without changing its boundary',
  (toolName, args) => {
    const { instance, pending } = runtime();
    const evaluation = instance.evaluateToolCall({
      toolName,
      argsJson: JSON.stringify(args),
    });
    expect(evaluation).toMatchObject({
      tier: 'red',
      baseTier: 'red',
      pinned: true,
      decision: 'required',
      pausedBy: 'protected',
    });
    expect(evaluation.reason).toMatch(/pinned-sensitive.*one-time approval/);
    expect(evaluation.reason).not.toContain('may change local state');
    expect(instance.formatApprovalRequest(evaluation)).toContain(
      `Why: ${evaluation.reason}`,
    );
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(pending, 'utf8'))),
    ).toContain(evaluation.reason);
  },
);

test('explains a custom pinned path without assuming it contains credentials', () => {
  const { instance } = runtime(
    'approval:\n  pinned_red:\n    - paths: ["records/**"]\n',
  );
  const evaluation = instance.evaluateToolCall({
    toolName: 'read',
    argsJson: JSON.stringify({ path: 'records/notes.txt' }),
  });
  expect(evaluation).toMatchObject({
    tier: 'red',
    pinned: true,
    decision: 'required',
  });
  expect(evaluation.reason).toMatch(/pinned-sensitive/);
  expect(evaluation.reason).not.toMatch(/credential|secret|password/i);
});

test('keeps an ordinary unpinned read automatic', () => {
  const { instance } = runtime();
  const evaluation = instance.evaluateToolCall({
    toolName: 'read',
    argsJson: JSON.stringify({ path: 'README.md' }),
  });
  expect(evaluation).toMatchObject({ pinned: false, decision: 'auto' });
  expect(evaluation.reason).not.toMatch(/pinned-sensitive/);
});

test('does not assert mutation for an unclassified shell command', () => {
  const { instance } = runtime();
  const evaluation = instance.evaluateToolCall({
    toolName: 'bash',
    argsJson: JSON.stringify({ command: 'inspect_unknown_format' }),
  });
  expect(evaluation.reason).toMatch(/not classified as read-only/);
  expect(evaluation.reason).not.toContain('may change local state');
});


test.each([
  ['bash', { command: 'ls -la /workspace/Repo/.env*' }, '/workspace/Repo/.env*'],
  ['bash', { command: 'git push --force origin HEAD:Release' }, 'HEAD:Release'],
  ['write', { path: '.env.Production', content: 'example' }, '.env.Production'],
] as const)('preserves case in the approval summary for %s %j', (toolName, args, target) => {
  const { instance } = runtime();
  const evaluation = instance.evaluateToolCall({
    toolName,
    argsJson: JSON.stringify(args),
  });
  expect(evaluation).toMatchObject({ pinned: true, decision: 'required' });
  const before = structuredClone(evaluation);
  const prompt = instance.formatApprovalRequest(evaluation);
  expect(prompt.split('\n')[0]).toContain(target);
  expect(prompt.split('\n').find(line => line.startsWith('Proposed action:'))).toContain(target);
  expect(parseTuiApprovalPrompt(prompt)?.intent).toBe(evaluation.intent);
  expect(evaluation).toEqual(before);
});
