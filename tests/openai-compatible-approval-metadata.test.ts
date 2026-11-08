import { expect, test } from 'vitest';
import type { GatewayChatResult } from '../src/gateway/gateway-types.js';
import {
  buildOpenAICompatibleCompletionResponse,
  buildOpenAICompatibleExecutionExtensions,
  buildOpenAICompatibleStreamStopChunk,
} from '../src/gateway/openai-compatible-response.js';

const approval: NonNullable<GatewayChatResult['pendingApproval']> = {
  approvalId: 'approval_a',
  toolName: 'bash',
  expiresAt: 1000,
  prompt: 'Review the action',
  intent: 'Run command',
  reason: 'Policy',
  commandPreview: 'private command',
  reviewArguments: 'private arguments',
  allowSession: false,
  allowAgent: false,
  allowAll: false,
};
const identity = { completionId: 'test', created: 0, model: 'test' };

test.each(['completion', 'stream'] as const)(
  '%s preserves a structured pending approval without review payloads',
  (mode) => {
    const extensions = buildOpenAICompatibleExecutionExtensions({
      pendingApproval: approval,
    });
    const response =
      mode === 'completion'
        ? buildOpenAICompatibleCompletionResponse({
            ...identity,
            content: 'Review needed',
            extensions,
          })
        : buildOpenAICompatibleStreamStopChunk({ ...identity, extensions });
    expect(response.hybridclaw).toEqual({
      pendingApproval: {
        approvalId: 'approval_a',
        toolName: 'bash',
        expiresAt: 1000,
      },
    });
    expect(JSON.stringify(response)).not.toContain('private');
  },
);

test('ordinary assistant prose is not a policy stop', () => {
  const extensions = buildOpenAICompatibleExecutionExtensions({});
  const result = buildOpenAICompatibleCompletionResponse({
    ...identity,
    content: 'This document discusses approval',
    extensions,
  });
  expect(result).not.toHaveProperty('hybridclaw');
});

test('delegation and pending approval metadata can coexist', () => {
  const delegation = { id: 'job_a', status: 'queued' } as const;
  expect(buildOpenAICompatibleExecutionExtensions({ delegation })).toEqual({
    hybridclaw: { delegation },
  });
  expect(
    buildOpenAICompatibleExecutionExtensions({
      delegation,
      pendingApproval: approval,
    }),
  ).toMatchObject({
    hybridclaw: { delegation, pendingApproval: { approvalId: 'approval_a' } },
  });
});
