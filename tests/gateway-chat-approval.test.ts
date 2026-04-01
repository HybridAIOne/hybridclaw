import { expect, test } from 'vitest';

import { extractGatewayChatApprovalEvent } from '../src/gateway/chat-approval.js';

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
        allowSession: true,
        allowAgent: false,
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
    allowSession: true,
    allowAgent: false,
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
        },
      ],
    }),
  ).toBeNull();
});
