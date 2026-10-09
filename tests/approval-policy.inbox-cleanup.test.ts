import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-inbox-cleanup-approval-');
useCleanMocks({ unstubAllEnvs: true });

function createRuntime(mode: 'auto' | 'ask' | 'full') {
  const dir = makeTempDir();
  const runtime = new TrustedAgentApprovalRuntime(
    path.join(dir, 'policy.yaml'),
    path.join(dir, 'agent-trust.json'),
    path.join(dir, 'all-trust.json'),
    path.join(dir, 'legacy-trust.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
  runtime.setApprovalMode({ mode });
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
    latestUserPrompt: 'Clean up my inbox',
  });
}

describe('inbox clean-up approvals', () => {
  test('archiving asks every time, even in full mode', () => {
    for (const mode of ['auto', 'ask', 'full'] as const) {
      const evaluation = evaluate(createRuntime(mode), 'inbox_cleanup', {
        action: 'apply',
        plan_id: '0123456789ab',
        groups: ['g1'],
      });
      expect(evaluation, mode).toMatchObject({
        tier: 'red',
        pinned: true,
        decision: 'required',
        actionKey: 'inbox_cleanup:apply',
      });
    }
  });

  test('planning only reads', () => {
    const evaluation = evaluate(createRuntime('auto'), 'inbox_cleanup', {
      action: 'plan',
    });
    expect(evaluation).toMatchObject({ tier: 'green' });
    expect(evaluation.decision).not.toBe('required');
  });

  test('the model cannot move mail around a plan', () => {
    for (const mode of ['auto', 'full'] as const) {
      const evaluation = evaluate(
        createRuntime(mode),
        'hybridai__mailbox__move_messages',
        { folder: 'INBOX', uidvalidity: 42, uids: [1], to: 'archive' },
      );
      expect(evaluation, mode).toMatchObject({ decision: 'denied' });
    }
  });
});
