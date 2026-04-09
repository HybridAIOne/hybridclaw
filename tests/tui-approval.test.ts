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
        'Reply `yes for all` to add this action to the workspace allowlist.',
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
    allowAll: true,
  });
});

test('parses always-style durable approval prompts into TUI approval details', () => {
  expect(
    parseTuiApprovalPrompt(
      [
        'I need your approval before I control a local app with `open -a Calendar`.',
        'Why: this command controls host GUI or application state',
        'Approval ID: approve123',
        'Reply `yes` to approve once.',
        'Reply `yes always` to trust this action for this conversation.',
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
    allowAll: false,
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
        'Reply `yes for all` is unavailable for pinned-sensitive actions.',
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
    allowAll: false,
  });
});

test('tracks agent and all approval options separately', () => {
  expect(
    parseTuiApprovalPrompt(
      [
        'I need your approval before I fetch a page.',
        'Why: this host is not yet trusted',
        'Approval ID: approve123',
        'Reply `yes` to approve once.',
        'Reply `yes for all` to add this action to the workspace allowlist.',
        'Reply `no` to deny.',
      ].join('\n'),
    ),
  ).toEqual({
    approvalId: 'approve123',
    intent: 'fetch a page',
    reason: 'this host is not yet trusted',
    allowSession: false,
    allowAgent: false,
    allowAll: true,
  });
});

test('parses session-only approval prompts for command-style approvals', () => {
  expect(
    parseTuiApprovalPrompt(
      [
        'I need your approval before I run `npm install --ignore-scripts --omit=dev --no-audit --no-fund` for plugin `mempalace-memory`.',
        'Why: this changes the local Node.js dependency state',
        'If you skip this, dependency installation will be skipped.',
        'Approval ID: approve123',
        'Reply `yes` to approve once.',
        'Reply `yes for session` to trust this action for this session.',
        'Reply `yes for agent` is unavailable for this approval.',
        'Reply `yes for all` is unavailable for this approval.',
        'Reply `no` to deny.',
        'Approval expires in 120s.',
      ].join('\n'),
    ),
  ).toEqual({
    approvalId: 'approve123',
    intent:
      'run `npm install --ignore-scripts --omit=dev --no-audit --no-fund` for plugin `mempalace-memory`',
    reason: 'this changes the local Node.js dependency state',
    allowSession: true,
    allowAgent: false,
    allowAll: false,
  });
});
