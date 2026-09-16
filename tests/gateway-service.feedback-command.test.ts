import fs from 'node:fs';

import { afterEach, expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-feedback-',
  envVars: ['HYBRIDAI_BASE_URL', 'HYBRIDAI_API_KEY'],
});

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

async function setup(options?: { enabled?: boolean; apiKey?: string }) {
  const homeDir = setupHome({
    HYBRIDAI_BASE_URL: 'https://hybridai.example.com',
    HYBRIDAI_API_KEY: options?.apiKey ?? 'test-key',
  });
  fs.mkdirSync(`${homeDir}/.hybridclaw`, { recursive: true });
  fs.writeFileSync(
    `${homeDir}/.hybridclaw/config.json`,
    `${JSON.stringify(
      { feedback: { drafts: { enabled: options?.enabled ?? true } } },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  const db = await import('../src/memory/db.ts');
  const feedback = await import('../src/gateway/feedback-drafts.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession(
    'agent:main:channel:msteams:chat:dm:peer:feedback-user',
    null,
    'msteams-conversation',
    'main',
  );
  const command = (args: string[]) =>
    handleGatewayCommand({
      sessionId: session.id,
      guildId: null,
      channelId: 'msteams-conversation',
      userId: 'teams-user',
      username: 'Teams User',
      args,
    });
  return { db, feedback, session, command };
}

function queueDraft(
  feedback: Awaited<ReturnType<typeof setup>>['feedback'],
  sessionId: string,
  title = 'bash tool lost persistent state',
) {
  return feedback.createFeedbackDraft({
    sessionId,
    agentId: 'main',
    channelId: 'msteams-conversation',
    model: 'test-model',
    provider: 'hybridai',
    draft: {
      type: 'bug',
      title,
      details:
        "**What happened:** bash session reset between calls.\n**What the user said:** User didn't comment; observed by the model.\n**Repro:** run `cd /tmp` then `pwd` in two calls.",
      area: 'bash tool',
    },
  }).draft;
}

test('feedback list is empty until the agent queues a draft', async () => {
  const { feedback, session, command } = await setup();
  const empty = await command(['feedback']);
  expect(empty.kind).toBe('plain');
  expect(empty.text).toContain('No queued feedback drafts');

  const draft = queueDraft(feedback, session.id);
  const listed = await command(['feedback', 'list']);
  expect(listed.kind).toBe('info');
  expect(listed.text).toContain(draft.id);
  expect(listed.text).toContain('bash tool lost persistent state');
});

test('feedback view marks the draft reviewed and send forwards it with provenance', async () => {
  const { db, feedback, session, command } = await setup();
  const draft = queueDraft(feedback, session.id);
  db.storeMessage(session.id, 'teams-user', 'Teams User', 'user', 'pwd broke');
  db.storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Working directory was reset. token=sk-abcdefghijklmnopqrstuvwxyz1234567890',
    'main',
  );

  const viewed = await command(['feedback', 'view', draft.id]);
  expect(viewed.kind).toBe('info');
  expect(viewed.text).toContain('**bash tool lost persistent state**');
  expect(viewed.text).toContain('Area: bash tool');

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  const sent = await command(['feedback', 'send', draft.id, '--transcript']);
  expect(sent.kind).toBe('plain');
  expect(sent.text).toContain(`Sent feedback draft \`${draft.id}\``);
  expect(sent.text).toContain('transcript excerpt');

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe('https://hybridai.example.com/api/agent_feedback');
  const body = calls[0]?.body as {
    draft_id: string;
    type: string;
    review: { viewed_before_send: boolean; submitted_via: string };
    context: { session_id: string; gateway_version: string };
    transcript: { messages: Array<{ role: string; content: string }> };
  };
  expect(body.draft_id).toBe(draft.id);
  expect(body.type).toBe('bug');
  expect(body.review.viewed_before_send).toBe(true);
  expect(body.review.submitted_via).toBe('msteams-conversation');
  expect(body.context.session_id).toBe(session.id);
  expect(body.context.gateway_version).not.toBe('');
  expect(body.transcript.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(JSON.stringify(body)).not.toContain(
    'sk-abcdefghijklmnopqrstuvwxyz1234567890',
  );

  expect(db.getFeedbackDraft(draft.id)?.status).toBe('submitted');
  const again = await command(['feedback', 'send', draft.id]);
  expect(again.kind).toBe('error');
  expect(again.text).toContain('already submitted');
});

test('feedback send without --transcript omits the transcript and keeps the draft on failure', async () => {
  const { db, feedback, session, command } = await setup();
  const draft = queueDraft(feedback, session.id);

  let payload: Record<string, unknown> | null = null;
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('nope', { status: 503 });
  }) as typeof fetch;

  const failed = await command(['feedback', 'send', draft.id]);
  expect(failed.kind).toBe('error');
  expect(failed.text).toContain('HTTP 503');
  expect(failed.text).toContain('stays queued');
  expect(payload).not.toBeNull();
  expect((payload as Record<string, unknown>).transcript).toBeUndefined();
  expect(db.getFeedbackDraft(draft.id)?.status).toBe('queued');
});

test('feedback discard drops the draft without a network call', async () => {
  const { db, feedback, session, command } = await setup();
  const draft = queueDraft(feedback, session.id);
  globalThis.fetch = vi.fn(async () => {
    throw new Error('should not be called');
  }) as typeof fetch;

  const discarded = await command(['feedback', 'discard', draft.id]);
  expect(discarded.kind).toBe('plain');
  expect(discarded.text).toContain('Nothing was sent');
  expect(db.getFeedbackDraft(draft.id)?.status).toBe('discarded');

  const missing = await command(['feedback', 'view', 'fbd_0000000000']);
  expect(missing.kind).toBe('error');
  expect(missing.text).toContain('was not found');

  const usage = await command(['feedback', 'send']);
  expect(usage.kind).toBe('error');
  expect(usage.title).toBe('Usage');
});

test('feedback command reports when drafts are disabled', async () => {
  const { command } = await setup({ enabled: false });
  const result = await command(['feedback', 'list']);
  expect(result.kind).toBe('error');
  expect(result.text).toContain('feedback.drafts.enabled');
});
