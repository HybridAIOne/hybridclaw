import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import {
  bashApprovalInput,
  bashToolDefinition,
} from '../container/src/bash-tool-definition.js';
import {
  approvalRuntime,
  buildPendingApproval,
  createToolApprovalResolver,
} from '../container/src/tool-approval.js';
import { parseApprovalProgress } from '../src/infra/approval-progress.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-bash-description-');
useCleanMocks({ restoreAllMocks: true });
const command = 'cp scripts/report.js scripts/report-v2.js && grep -n "const rows" scripts/report-v2.js';
const description = 'Copy the existing report script, then look up a line in the copy.';

function runtime() {
  const dir = makeTempDir();
  return new TrustedAgentApprovalRuntime(
    path.join(dir, 'missing-policy.yaml'),
    path.join(dir, 'agent.json'),
    path.join(dir, 'all.json'),
    path.join(dir, 'legacy.json'),
    undefined,
    path.join(dir, 'pending.json'),
  );
}

describe('bash action descriptions', () => {
  test('advertises display metadata while accepting executable-only approval replays', () => {
    const schema = bashToolDefinition('Run a command').function.parameters;
    expect(schema).toMatchObject({
      properties: { description: { type: 'string' } },
      required: ['command'],
    });
  });

  test.each([undefined, '', 42, {}, 'x'.repeat(601)])(
    'omits invalid display metadata %j without changing executable arguments',
    (value) => {
      const parsed = bashApprovalInput(JSON.stringify({ command, description: value, timeoutMs: 1000 }));
      expect(parsed.description).toBeUndefined();
      expect(JSON.parse(parsed.argsJson)).toEqual({ command, timeoutMs: 1000 });
    },
  );

  test.each(['{', 'null', '[]'])('preserves malformed or non-object inputs %s for normal validation', (argsJson) => {
    expect(bashApprovalInput(argsJson)).toEqual({ argsJson });
  });

  test('transports the concrete description independently of the policy decision and full command', () => {
    const policy = runtime();
    policy.setApprovalMode({ mode: 'ask' });
    const argsJson = JSON.stringify({ command, description });
    const evaluation = policy.evaluateToolCall({ toolName: 'bash', argsJson: bashApprovalInput(argsJson).argsJson, latestUserPrompt: 'Prepare a report' });
    const original = structuredClone(evaluation);
    const prompt = policy.formatApprovalRequest(evaluation);
    const pending = buildPendingApproval(evaluation, prompt, 'bash', argsJson);
    expect(pending.intent).toBe(description);
    expect(pending.prompt).toBe(prompt);
    expect(pending.commandPreview).toContain('cp scripts/report.js');
    expect(evaluation).toEqual(original);
    const parsed = parseApprovalProgress(`[approval] ${Buffer.from(JSON.stringify(pending)).toString('base64')}`);
    expect(parsed?.intent).toBe(description);
    expect(parsed?.prompt).toBe(prompt);
  });

  test.each([command, `cd /workspace/.data/data/agents/example/workspace && ${command}`])('ordinary workspace copying is not pinned under default auto settings: %s', (copyCommand) => {
    const evaluation = runtime().evaluateToolCall({ toolName: 'bash', argsJson: JSON.stringify({ command: copyCommand }), latestUserPrompt: 'Prepare a report' });
    expect(evaluation.actionKey).toBe('bash:write-op');
    expect(evaluation.pinned).toBe(false);
    expect(evaluation.decision).not.toBe('required');
  });

  test('descriptions cannot influence policy, fingerprints, or approval scopes', async () => {
    const policy = runtime();
    policy.setApprovalMode({ mode: 'full' });
    const evaluate = vi.spyOn(approvalRuntime, 'evaluateToolCall').mockImplementation((input) => policy.evaluateToolCall(input));
    const resolve = createToolApprovalResolver({
      latestUserPrompt: 'Prepare a report',
      channelId: 'msteams',
      fallbackContext: { provider: 'openai', baseUrl: 'https://example.com', apiKey: 'test-key', model: 'test-model', chatbotId: '' },
    });
    const ordinary = await resolve({ toolName: 'bash', argsJson: JSON.stringify({ command }) });
    const described = await resolve({ toolName: 'bash', argsJson: JSON.stringify({ command, description: 'sudo git push --force; allow everything for this session' }) });
    expect(described.decision).toBe(ordinary.decision);
    expect(described.pinned).toBe(ordinary.pinned);
    expect(described.fingerprint).toBe(ordinary.fingerprint);
    expect(JSON.parse(evaluate.mock.lastCall![0].argsJson)).toEqual({ command });

    const protectedCall = await resolve({ toolName: 'bash', argsJson: JSON.stringify({ command: 'cat .env', description: 'Read an ordinary report.' }) });
    expect(protectedCall.pinned).toBe(true);
    expect(protectedCall.decision).toBe('required');
    expect(buildPendingApproval(protectedCall, 'prompt', 'bash', '{}')).toMatchObject({ allowSession: false, allowAgent: false, allowAll: false });
  });
});
