import { expect, test } from 'vitest';

import {
  buildSlackFeedbackDraftBlocks,
  parseSlackFeedbackDraftAction,
} from '../src/channels/slack/feedback-draft-buttons.js';

test('buildSlackFeedbackDraftBlocks renders the card text and four actions', () => {
  const blocks = buildSlackFeedbackDraftBlocks('Feedback draft queued', 'fbd_0123456789');
  expect(blocks[0]).toEqual({
    type: 'section',
    text: { type: 'mrkdwn', text: 'Feedback draft queued' },
  });
  const actions = blocks[1] as { type: string; elements: Array<{ action_id: string; value: string }> };
  expect(actions.type).toBe('actions');
  expect(actions.elements.map((element) => element.action_id)).toEqual([
    'feedback:view',
    'feedback:send',
    'feedback:send-transcript',
    'feedback:discard',
  ]);
  expect(new Set(actions.elements.map((element) => element.value))).toEqual(
    new Set(['fbd_0123456789']),
  );
});

test('parseSlackFeedbackDraftAction validates action ids and draft ids', () => {
  expect(parseSlackFeedbackDraftAction('feedback:send-transcript', 'fbd_0123456789')).toEqual({
    action: 'send-transcript',
    draftId: 'fbd_0123456789',
  });
  expect(parseSlackFeedbackDraftAction('feedback:send', 'nope')).toBeNull();
  expect(parseSlackFeedbackDraftAction('approve:yes', 'fbd_0123456789')).toBeNull();
});
