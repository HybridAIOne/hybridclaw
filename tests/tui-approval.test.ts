import { expect, test } from 'vitest';

import {
  formatTuiApprovalSummary,
  parseTuiApprovalPrompt,
} from '../src/tui-approval.js';

test('formats a compact approval summary with intent and reason', () => {
  expect(
    formatTuiApprovalSummary({
      approvalId: 'approve123',
      intent: 'control a local app with `open -a Music`',
      reason: 'this command controls host GUI or application state',
    }),
  ).toBe(
    [
      'Approval needed for: control a local app with `open -a Music`',
      'Why: this command controls host GUI or application state',
      'Approval ID: approve123',
    ].join('\n'),
  );
});

test('omits empty intent and reason lines', () => {
  expect(
    formatTuiApprovalSummary({
      approvalId: 'approve123',
      intent: ' ',
      reason: '',
    }),
  ).toBe('Approval ID: approve123');
});

test('parses raw runtime approval prompts into TUI approval details', () => {
  expect(
    parseTuiApprovalPrompt(
      [
        'I need your approval before I control a local app with `open -a Calendar`.',
        'Why: this command controls host GUI or application state',
        'If you skip this, i will avoid controlling host applications and keep the task read-only.',
        'Approval ID: approve123',
        'Reply `yes` to approve once.',
        'Reply `yes for session` to trust this action for this session.',
        'Reply `yes for agent` to trust it for this agent.',
        'Reply `no` to deny.',
        'Approval expires in 120s.',
      ].join('\n'),
    ),
  ).toEqual({
    approvalId: 'approve123',
    intent: 'control a local app with `open -a Calendar`',
    reason: 'this command controls host GUI or application state',
    allowSession: true,
    allowAgent: true,
  });
});

test('parses pinned runtime approval prompts without durable trust options', () => {
  expect(
    parseTuiApprovalPrompt(
      [
        'I need your approval before I run script `danger.sh`.',
        'Why: script execution is treated as high risk',
        'Approval ID: approve123',
        'Reply `yes` to approve once.',
        'Reply `yes for session` is unavailable for pinned-sensitive actions.',
        'Reply `yes for agent` is unavailable for pinned-sensitive actions.',
        'Reply `no` to deny.',
        'Approval expires in 120s.',
      ].join('\n'),
    ),
  ).toEqual({
    approvalId: 'approve123',
    intent: 'run script `danger.sh`',
    reason: 'script execution is treated as high risk',
    allowSession: false,
    allowAgent: false,
  });
});
