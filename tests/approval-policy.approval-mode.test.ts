import path from 'node:path';
import { expect, test } from 'vitest';
import type { ApprovalMode } from '../container/shared/approval-mode.js';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-approval-mode-');

function evaluate(
  mode: ApprovalMode,
  toolName: string,
  args: Record<string, unknown>,
) {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'missing-policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode });
  return runtime.evaluateToolCall({
    toolName,
    argsJson: JSON.stringify(args),
    latestUserPrompt: 'Do the task',
  });
}

const READ = ['read', { path: 'README.md' }] as const;
const WRITE = ['write', { path: 'app/notes.txt', contents: 'x' }] as const;
const DESTRUCTIVE = ['bash', { command: 'rm -rf dist' }] as const;
const PINNED = ['write', { path: '.env', contents: 'API_KEY=abc' }] as const;

test.each([
  ['ask', READ, false],
  ['ask', WRITE, true],
  ['ask', DESTRUCTIVE, true],
  ['ask', PINNED, true],
  ['auto', READ, false],
  ['auto', WRITE, false],
  ['auto', DESTRUCTIVE, true],
  ['auto', PINNED, true],
  ['full', READ, false],
  ['full', WRITE, false],
  ['full', DESTRUCTIVE, false],
  ['full', PINNED, true],
] as const)('%s mode: %j prompts=%s', (mode, [toolName, args], prompts) => {
  const evaluation = evaluate(mode, toolName, args);
  expect(evaluation.decision === 'required').toBe(prompts);
  expect(Boolean(evaluation.requestId)).toBe(prompts);
});
