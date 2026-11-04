import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-approval-dry-run-');

const ALLOW_API_POLICY = `
network:
  default: deny
  rules:
    - action: allow
      host: "api.example.com"
      methods: ["*"]
`;

function createRuntime(dryRun: boolean): TrustedAgentApprovalRuntime {
  const dir = makeTempDir();
  const policyPath = path.join(dir, 'policy.yaml');
  fs.writeFileSync(policyPath, ALLOW_API_POLICY, 'utf-8');
  const runtime = new TrustedAgentApprovalRuntime(
    policyPath,
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode: 'full', dryRun });
  return runtime;
}

function evaluate(
  runtime: TrustedAgentApprovalRuntime,
  toolName: string,
  args: Record<string, unknown>,
) {
  return runtime.evaluateToolCall({
    toolName,
    argsJson: JSON.stringify(args),
    latestUserPrompt: 'When does order 42 ship?',
  });
}

test.each([
  ['delegate', { prompt: 'Note in MEMORY.md that order 42 shipped' }],
  ['show_dashboard', { title: 'Orders' }],
  ['show_widget', { title: 'Order status' }],
  ['draft_transfer', { name: 'Refund order 42' }],
  ['show_slide_samples', {}],
  ['delete', { path: 'BOOTSTRAP.md' }],
  ['http_request', { url: 'https://api.example.com/orders', method: 'POST' }],
  ['bash', { command: 'curl -X POST https://api.example.com/orders' }],
  ['bash', { command: 'curl -d status=shipped https://api.example.com/o/42' }],
  ['bash', { command: 'curl -T orders.csv https://api.example.com/upload' }],
])('a dry run refuses green %s %j, which starts work or changes something', (toolName, args) => {
  expect(evaluate(createRuntime(false), toolName, args)).toMatchObject({
    tier: 'green',
  });
  expect(evaluate(createRuntime(true), toolName, args)).toMatchObject({
    decision: 'denied',
    escalationRoute: 'policy_denial',
  });
});

test.each([
  ['read', { path: 'MEMORY.md' }],
  ['http_request', { url: 'https://api.example.com/orders', method: 'GET' }],
  ['bash', { command: 'curl https://api.example.com/orders/42' }],
])('a dry run runs the read %s %j', (toolName, args) => {
  const evaluation = evaluate(createRuntime(true), toolName, args);
  expect(evaluation.tier).toBe('green');
  expect(evaluation.decision).not.toBe('denied');
});

test('session trust does not let a write through a dry run', () => {
  const runtime = createRuntime(false);
  runtime.setApprovalMode({ mode: 'auto' });
  const args = { command: 'touch /Users/example/report.txt' };
  expect(evaluate(runtime, 'bash', args).decision).toBe('required');
  runtime.handleApprovalResponse([
    { role: 'user', content: 'yes for session' },
  ]);
  expect(evaluate(runtime, 'bash', args).decision).toBe('approved_session');

  runtime.setApprovalMode({ mode: 'auto', dryRun: true });
  expect(evaluate(runtime, 'bash', args).decision).toBe('denied');
});
