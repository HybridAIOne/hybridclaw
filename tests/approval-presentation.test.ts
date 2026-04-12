import { expect, test } from 'vitest';

import {
  createApprovalPresentation,
  getApprovalPromptText,
  getApprovalVisibleText,
} from '../src/gateway/approval-presentation.js';

test('maps buttons mode to buttons-only presentation flags', () => {
  expect(createApprovalPresentation('buttons')).toEqual({
    mode: 'buttons',
    showText: true,
    showButtons: true,
    showReplyText: false,
  });
});

test('prefers the full approval prompt when rendering stored text', () => {
  expect(
    getApprovalPromptText({
      prompt: 'I need your approval before I access example.com.',
      summary:
        'Approval needed for: access example.com\nWhy: this would contact a new external host\nApproval ID: approve123',
    }),
  ).toBe('I need your approval before I access example.com.');
});

test('hides manual reply instructions in buttons-only mode', () => {
  expect(
    getApprovalVisibleText(
      {
        prompt: [
          'I need your approval before I access example.com.',
          'Why: this would contact a new external host',
          'Approval ID: approve123',
          'Reply `yes` to approve once.',
          'Reply `yes for session` to trust this action for this session.',
          'Approval expires in 120s.',
        ].join('\n'),
      },
      createApprovalPresentation('buttons'),
    ),
  ).toBe(
    [
      'I need your approval before I access example.com.',
      'Why: this would contact a new external host',
      'Approval ID: approve123',
      'Approval expires in 120s.',
    ].join('\n'),
  );
});
