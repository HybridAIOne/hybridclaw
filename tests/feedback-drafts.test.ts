import fs from 'node:fs';

import { expect, test } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-feedback-drafts-',
});

async function setup(enabled = true) {
  const homeDir = setupHome();
  fs.mkdirSync(`${homeDir}/.hybridclaw`, { recursive: true });
  fs.writeFileSync(
    `${homeDir}/.hybridclaw/config.json`,
    `${JSON.stringify({ feedback: { drafts: { enabled } } })}\n`,
    'utf-8',
  );
  const db = await import('../src/memory/db.ts');
  const feedback = await import('../src/gateway/feedback-drafts.ts');
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession(
    'agent:main:channel:web:chat:dm:peer:feedback-drafts',
    null,
    'web',
    'main',
  );
  return { db, feedback, session };
}

const VALID_DRAFT = {
  type: 'bug',
  title: 'memory tool rejected a valid daily note path',
  details:
    '**What happened:** append to memory/2026-09-16.md failed with "path not allowed".\n**What the user said:** "why can it not remember this?"\n**Repro:** call memory append with target=daily.',
  area: 'memory',
  failure_mode: 'other',
  task_category: 'chat',
};

test('createFeedbackDraft persists, enriches, redacts and audits the draft', async () => {
  const { db, feedback, session } = await setup();
  const result = feedback.createFeedbackDraft({
    sessionId: session.id,
    agentId: 'main',
    channelId: 'web',
    model: 'test-model',
    provider: 'hybridai',
    draft: {
      ...VALID_DRAFT,
      details: `${VALID_DRAFT.details}\n**Evidence:** Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890`,
    },
  });
  expect(result.deduplicated).toBe(false);
  const draft = result.draft;
  expect(draft.id).toMatch(/^fbd_[0-9a-f]{10}$/);
  expect(draft.status).toBe('queued');
  expect(draft.trigger).toBe('model_judgment');
  expect(draft.agent_id).toBe('main');
  expect(draft.model).toBe('test-model');
  expect(draft.provider).toBe('hybridai');
  expect(draft.gateway_version).toBeTruthy();
  expect(draft.details).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890');
  expect(new Date(draft.expires_at).getTime() - new Date(draft.created_at).getTime()).toBe(
    30 * 24 * 60 * 60 * 1000,
  );

  const audit = db.getStructuredAuditForSession(session.id);
  const created = audit.find((row) => row.event_type === 'feedback.draft.created');
  expect(created).toBeDefined();
  expect(JSON.parse(created?.payload ?? '{}')).toMatchObject({
    draftId: draft.id,
    draftType: 'bug',
    area: 'memory',
  });
});

test('createFeedbackDraft deduplicates by title and caps queued drafts per session', async () => {
  const { feedback, session } = await setup();
  const first = feedback.createFeedbackDraft({ sessionId: session.id, draft: VALID_DRAFT });
  const second = feedback.createFeedbackDraft({
    sessionId: session.id,
    draft: { ...VALID_DRAFT, title: VALID_DRAFT.title.toUpperCase() },
  });
  expect(second.deduplicated).toBe(true);
  expect(second.draft.id).toBe(first.draft.id);

  for (let index = 1; index < 10; index += 1) {
    feedback.createFeedbackDraft({
      sessionId: session.id,
      draft: { ...VALID_DRAFT, title: `distinct issue ${index}` },
    });
  }
  expect(() =>
    feedback.createFeedbackDraft({
      sessionId: session.id,
      draft: { ...VALID_DRAFT, title: 'one too many' },
    }),
  ).toThrow(/already has 10 queued/);
});

test('createFeedbackDraft rejects invalid payloads and unknown sessions', async () => {
  const { feedback, session } = await setup();
  expect(() =>
    feedback.createFeedbackDraft({
      sessionId: session.id,
      draft: { ...VALID_DRAFT, type: 'rant' },
    }),
  ).toThrow(/`type` must be one of/);
  expect(() =>
    feedback.createFeedbackDraft({
      sessionId: session.id,
      draft: { ...VALID_DRAFT, details: '' },
    }),
  ).toThrow(/`details` is required/);
  expect(() =>
    feedback.createFeedbackDraft({
      sessionId: session.id,
      draft: { ...VALID_DRAFT, failure_mode: 'grumpy' },
    }),
  ).toThrow(/`failure_mode` must be one of/);
  expect(() =>
    feedback.createFeedbackDraft({ sessionId: 'agent:nope', draft: VALID_DRAFT }),
  ).toThrow(/was not found/);
});

test('createFeedbackDraft refuses when the feature is disabled', async () => {
  const { feedback, session } = await setup(false);
  expect(feedback.isFeedbackDraftsEnabled()).toBe(false);
  expect(() =>
    feedback.createFeedbackDraft({ sessionId: session.id, draft: VALID_DRAFT }),
  ).toThrow(feedback.FeedbackDraftsDisabledError);
});

test('queued drafts past their retention window expire on listing', async () => {
  const { db, feedback, session } = await setup();
  const old = db.insertFeedbackDraft({
    sessionId: session.id,
    trigger: 'model_judgment',
    type: 'idea',
    title: 'stale idea',
    details: 'details',
    now: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
  });
  const fresh = feedback.createFeedbackDraft({ sessionId: session.id, draft: VALID_DRAFT });
  const listed = feedback.listSessionFeedbackDrafts(session.id);
  expect(listed.map((draft) => draft.id)).toEqual([fresh.draft.id]);
  expect(db.getFeedbackDraft(old.id)?.status).toBe('expired');
});

test('submitFeedbackDraft requires a signed-in HybridAI account', async () => {
  const { feedback, session } = await setup();
  const { draft } = feedback.createFeedbackDraft({ sessionId: session.id, draft: VALID_DRAFT });
  await expect(
    feedback.submitFeedbackDraft({ id: draft.id, operatorUserId: 'user_a' }),
  ).rejects.toThrow(/Not signed in to HybridAI/);
});

test('report_feedback is blocked from the tool list until the feature is enabled', async () => {
  const disabled = await setup(false);
  const policyDisabled = await import('../src/agent/tool-policy.ts');
  expect(policyDisabled.mergeBlockedToolNames()).toContain('report_feedback');
  void disabled;

  const enabled = await setup(true);
  const policyEnabled = await import('../src/agent/tool-policy.ts');
  expect(policyEnabled.mergeBlockedToolNames() ?? []).not.toContain(
    'report_feedback',
  );
  void enabled;
});
