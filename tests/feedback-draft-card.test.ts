import fs from 'node:fs';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-feedback-card-',
});

async function setup() {
  const homeDir = setupHome();
  fs.mkdirSync(`${homeDir}/.hybridclaw`, { recursive: true });
  fs.writeFileSync(
    `${homeDir}/.hybridclaw/config.json`,
    `${JSON.stringify({ feedback: { drafts: { enabled: true } } })}\n`,
    'utf-8',
  );
  const db = await import('../src/memory/db.ts');
  const drafts = await import('../src/gateway/feedback-drafts.ts');
  const card = await import('../src/gateway/feedback-draft-card.ts');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession(
    'agent:main:channel:web:chat:dm:peer:card',
    null,
    'web',
    'main',
  );
  return { db, drafts, card, session };
}

test('feedback draft components and custom ids round-trip', async () => {
  const { card } = await setup();
  const components = card.buildFeedbackDraftComponents('fbd_0123456789');
  const row = components[0] as { components: Array<{ custom_id: string; label: string }> };
  expect(row.components.map((button) => button.custom_id)).toEqual([
    'feedback:view:fbd_0123456789',
    'feedback:send:fbd_0123456789',
    'feedback:send-transcript:fbd_0123456789',
    'feedback:discard:fbd_0123456789',
  ]);
  expect(row.components.map((button) => button.label)).toEqual([
    'View',
    'Send',
    'Send + transcript',
    'Discard',
  ]);
  for (const button of row.components) {
    const parsed = card.parseFeedbackDraftCustomId(button.custom_id);
    expect(parsed?.draftId).toBe('fbd_0123456789');
  }
  expect(card.parseFeedbackDraftCustomId('feedback:nuke:fbd_0123456789')).toBeNull();
  expect(card.parseFeedbackDraftCustomId('feedback:send:not-an-id')).toBeNull();
  expect(card.feedbackDraftActionToCommandArgs('send-transcript', 'fbd_0123456789')).toEqual([
    'feedback',
    'send',
    'fbd_0123456789',
    '--transcript',
  ]);
  expect(card.feedbackDraftActionToCommandArgs('discard', 'fbd_0123456789')).toEqual([
    'feedback',
    'discard',
    'fbd_0123456789',
  ]);
});

test('extractFeedbackDraftsFromToolExecutions resolves queued drafts from tool output', async () => {
  const { drafts, card, session } = await setup();
  const { draft } = drafts.createFeedbackDraft({
    sessionId: session.id,
    draft: {
      type: 'idea',
      title: 'let /status show queued feedback drafts',
      details: '**What happened:** operators cannot see drafts at a glance.',
    },
  });
  const discarded = drafts.createFeedbackDraft({
    sessionId: session.id,
    draft: { type: 'bug', title: 'already handled', details: 'details' },
  }).draft;
  drafts.discardFeedbackDraft({ id: discarded.id, operatorUserId: 'user_a' });

  const extracted = card.extractFeedbackDraftsFromToolExecutions([
    { name: 'bash', result: '{"success":true,"draftId":"fbd_0000000000"}' },
    { name: 'report_feedback', result: 'Error: `title` is required.' },
    {
      name: 'report_feedback',
      result: JSON.stringify({ success: true, draftId: draft.id, deduplicated: false }),
    },
    {
      name: 'report_feedback',
      result: JSON.stringify({ success: true, draftId: draft.id, deduplicated: false }),
    },
    {
      name: 'report_feedback',
      result: JSON.stringify({ success: true, draftId: discarded.id, deduplicated: false }),
    },
    {
      name: 'report_feedback',
      result: JSON.stringify({ success: true, draftId: 'fbd_ffffffffff', deduplicated: true }),
    },
  ]);
  expect(extracted).toEqual([
    {
      draftId: draft.id,
      type: 'idea',
      title: 'let /status show queued feedback drafts',
      trigger: 'model_judgment',
    },
  ]);
  expect(card.formatFeedbackDraftCardText(extracted[0]!)).toContain(
    `/feedback view ${draft.id}`,
  );
  expect(card.extractFeedbackDraftsFromToolExecutions(undefined)).toEqual([]);
});
