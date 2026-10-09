import { expect, test } from 'vitest';

import { extractGatewayChatApprovalEvent } from '../src/gateway/chat-approval.js';
import { parseApprovalProgress } from '../src/infra/approval-progress.js';

test('extracts approval event metadata from a pending approval result', () => {
  expect(
    extractGatewayChatApprovalEvent({
      status: 'success',
      result:
        'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
      toolsUsed: ['bash'],
      pendingApproval: {
        approvalId: 'approve123',
        prompt: 'I need your approval before I control a local app.',
        intent: 'control a local app with `open -a Music`',
        reason: 'this command controls host GUI or application state',
        approvalTier: 'yellow',
        toolName: 'bash',
        commandPreview: 'open -a Music',
        allowSession: true,
        allowAgent: false,
        allowAll: false,
        expiresAt: 1_710_000_000_000,
      },
    }),
  ).toEqual({
    type: 'approval',
    approvalId: 'approve123',
    prompt: 'I need your approval before I control a local app.',
    summary:
      'Approval needed for: control a local app with `open -a Music`\nWhy: this command controls host GUI or application state\nApproval ID: approve123',
    intent: 'control a local app with `open -a Music`',
    reason: 'this command controls host GUI or application state',
    approvalTier: 'yellow',
    toolName: 'bash',
    commandPreview: 'open -a Music',
    allowSession: true,
    allowAgent: false,
    allowAll: false,
    expiresAt: 1_710_000_000_000,
  });
});

test('returns null when there is no structured pending approval metadata', () => {
  expect(
    extractGatewayChatApprovalEvent({
      status: 'success',
      result: 'Playing Apple Music now.',
      toolsUsed: ['bash'],
      toolExecutions: [
        {
          name: 'bash',
          arguments: 'open -a Music',
          result: 'I need your approval before I control a local app.',
          durationMs: 12,
          approvalDecision: 'required',
          approvalRequestId: 'approve123',
          approvalAllowSession: true,
          approvalAllowAgent: true,
          approvalAllowAll: true,
        },
      ],
    }),
  ).toBeNull();
});

test('a boost question keeps its popup fields from the worker to the app', () => {
  const boost = { category: 'image', modelName: 'Flux 2 Pro', available: 3 };
  const line = (fields: object) =>
    `[approval] ${Buffer.from(
      JSON.stringify({
        approvalId: '0123456789abcdef0123456789abcdef',
        prompt: 'Use 1 boost (3 left) for Flux 2 Pro?',
        intent: 'use 1 boost for Flux 2 Pro',
        reason: 'This uses 1 of your 3 boosts.',
        toolName: 'hybridai__image_generate',
        allowSession: false,
        allowAgent: false,
        allowAll: false,
        expiresAt: 1_710_000_000_000,
        ...fields,
      }),
    ).toString('base64')}`;

  const pendingApproval = parseApprovalProgress(line({ boost }));

  expect(pendingApproval?.boost).toEqual(boost);
  expect(
    parseApprovalProgress(line({ boost: { ...boost, available: -1 } })),
  ).not.toHaveProperty('boost');
  expect(
    extractGatewayChatApprovalEvent({
      status: 'success',
      result: 'Use 1 boost (3 left) for Flux 2 Pro?',
      toolsUsed: [],
      ...(pendingApproval ? { pendingApproval } : {}),
    }),
  ).toMatchObject({
    type: 'approval',
    approvalId: '0123456789abcdef0123456789abcdef',
    boost,
  });
});
