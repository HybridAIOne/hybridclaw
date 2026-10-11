import path from 'node:path';
import { expect, test } from 'vitest';
import type { ApprovalMode } from '../container/shared/approval-mode.js';
import { TrustedAgentApprovalRuntime } from '../container/src/approval-policy.js';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('hybridclaw-image-approval-');

function createRuntime(mode: ApprovalMode) {
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
  runtime.setMcpToolBehaviorResolver(() => ({
    kind: 'edit',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  }));
  return runtime;
}

test.each(['ask', 'auto', 'full'] as const)(
  '%s mode generates native and platform images without approval',
  (mode) => {
    const runtime = createRuntime(mode);
    for (const toolName of ['image_generate', 'hybridai__image_generate']) {
      for (const args of [{ prompt: 'A lighthouse at dusk' }, { action: 'list' }]) {
        const evaluation = runtime.evaluateToolCall({
          toolName,
          argsJson: JSON.stringify(args),
          latestUserPrompt: 'Create an illustration',
        });
        expect(evaluation).toMatchObject({ tier: 'green', decision: 'auto' });
        expect(evaluation.requestId).toBeUndefined();
        expect(evaluation.implicitDelayMs).toBeUndefined();
      }
    }
  },
);

test.each([
  'hybridai__google__send_mail',
  'hybridai__google__create_event',
  'other__image_generate',
  'hybridai__other__image_generate',
] as const)('the image exemption does not authorize %s', (toolName) => {
  for (const mode of ['ask', 'auto'] as const) {
    const evaluation = createRuntime(mode).evaluateToolCall({
      toolName,
      argsJson: JSON.stringify({ text: 'Example' }),
      latestUserPrompt: 'Do the task',
    });
    expect(evaluation).toMatchObject({
      tier: 'red',
      decision: 'required',
      requestId: expect.any(String),
    });
  }
});
