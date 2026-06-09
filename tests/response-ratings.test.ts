import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-response-ratings-');

useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  unmock: [
    '../src/audit/audit-events.js',
    '../src/auth/hybridai-auth.js',
    '../src/skills/skills-observation.js',
  ],
});

async function setup(options?: {
  apiKey?: string;
  authenticated?: boolean;
  chatbotId?: string | null;
}) {
  const recordAuditEvent = vi.fn();
  const recordSkillFeedbackForObservation = vi.fn();
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId: () => 'rating_run',
    recordAuditEvent,
  }));
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIAuthStatus: () => ({
      authenticated: options?.authenticated ?? Boolean(options?.apiKey),
      path: 'test',
      maskedApiKey: options?.apiKey ? 'hai-…test' : null,
      source: options?.apiKey ? 'env' : null,
    }),
    getHybridAIApiKey: () => {
      if (options?.apiKey) return options.apiKey;
      throw new Error('HYBRIDAI_API_KEY is not configured.');
    },
  }));
  vi.doMock('../src/skills/skills-observation.js', () => ({
    recordSkillFeedbackForObservation,
  }));

  const dbModule = await import('../src/memory/db.js');
  const dbPath = path.join(makeTempDir(), 'hybridclaw.db');
  dbModule.initDatabase({ quiet: true, dbPath });
  const session = dbModule.getOrCreateSession(
    'agent:main:channel:web:chat:dm:peer:response-ratings',
    null,
    'web',
    'main',
  );
  dbModule.updateSessionModel(session.id, 'hybridai/gpt-5');
  if (options?.chatbotId !== undefined) {
    dbModule.updateSessionChatbot(session.id, options.chatbotId);
  }
  const userMessageId = dbModule.storeMessage(
    session.id,
    'user_a',
    'User A',
    'user',
    'Hello',
  );
  dbModule.recordSkillObservation({
    skillName: 'support',
    sessionId: session.id,
    runId: 'run_1',
    agentId: 'main',
    outcome: 'success',
  });
  const assistantMessageId = dbModule.storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Hi there',
    'main',
  );

  const service = await import('../src/gateway/response-ratings.js');
  return {
    ...dbModule,
    ...service,
    recordAuditEvent,
    recordSkillFeedbackForObservation,
    sessionId: session.id,
    userMessageId,
    assistantMessageId,
  };
}

describe('response ratings', () => {
  test('migrates legacy source-surface rating schema before writing', async () => {
    const dbModule = await import('../src/memory/db.js');
    const dbPath = path.join(makeTempDir(), 'legacy-response-ratings.db');
    dbModule.initDatabase({ quiet: true, dbPath });
    dbModule.withMemoryDatabase((database) => {
      database.exec(`
        DROP TABLE response_ratings;
        CREATE TABLE response_ratings (
          session_id TEXT NOT NULL,
          message_id INTEGER NOT NULL,
          operator_user_id TEXT NOT NULL,
          source_surface TEXT NOT NULL,
          rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
          agent_id TEXT,
          model TEXT,
          provider TEXT,
          skill_name TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (session_id, message_id, operator_user_id, source_surface)
        );
        CREATE INDEX idx_response_ratings_message
          ON response_ratings(session_id, message_id);
        CREATE INDEX idx_response_ratings_updated
          ON response_ratings(updated_at);
        INSERT INTO response_ratings (
          session_id,
          message_id,
          operator_user_id,
          source_surface,
          rating,
          created_at,
          updated_at
        )
        VALUES (
          'session-a',
          1,
          'operator-a',
          'web',
          'up',
          '2026-05-27T12:00:00.000Z',
          '2026-05-27T12:00:00.000Z'
        );
      `);
    });

    dbModule.initDatabase({ quiet: true, dbPath });
    const updated = dbModule.upsertResponseRating({
      sessionId: 'session-a',
      messageId: 1,
      operatorUserId: 'operator-a',
      rating: 'down',
    });

    expect(updated.rating).toBe('down');
    dbModule.withMemoryDatabase((database) => {
      const table = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'response_ratings'",
        )
        .get() as { sql: string };
      expect(table.sql).not.toContain('source_surface');
      expect(table.sql).toContain(
        'PRIMARY KEY (session_id, message_id, operator_user_id)',
      );
    });
  });

  test('persists and updates one web rating per operator and response', async () => {
    const service = await setup();

    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });
    const updated = service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'down',
    });

    expect(updated.rating).toBe('down');
    expect(
      service.getResponseRatingsForMessages({
        sessionId: service.sessionId,
        messageIds: [service.assistantMessageId],
        operatorUserId: 'operator-a',
      }),
    ).toEqual(new Map([[service.assistantMessageId, 'down']]));
  });

  test('emits observability and skill feedback metadata for accepted ratings', async () => {
    const service = await setup();

    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });

    expect(service.recordAuditEvent).toHaveBeenCalledWith({
      sessionId: service.sessionId,
      runId: 'rating_run',
      event: expect.objectContaining({
        type: 'response.rating',
        messageId: service.assistantMessageId,
        agentId: 'main',
        model: 'hybridai/gpt-5',
        provider: 'hybridai',
        skillName: 'support',
        skillRunId: 'run_1',
        skillObservationId: expect.any(Number),
        operatorUserId: 'operator-a',
        sourceSurface: 'web',
        rating: 'up',
      }),
    });
    expect(service.recordSkillFeedbackForObservation).toHaveBeenCalledWith({
      observationId: expect.any(Number),
      sessionId: service.sessionId,
      feedback: expect.stringContaining('thumbs_up'),
      sentiment: 'positive',
    });
  });

  test('forwards accepted HybridAI ratings to chat feedback endpoint with stored prompt and response', async () => {
    vi.stubEnv('HYBRIDAI_BASE_URL', 'https://hybridai.example/');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = await setup({
      apiKey: 'hai-feedback-test-key',
      chatbotId: 'bot-feedback',
    });

    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, request] = fetchMock.mock.calls[0] as [
      string,
      RequestInit & { body: string },
    ];
    expect(url).toBe('https://hybridai.example/api/chat_feedback');
    expect(request.method).toBe('POST');
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer hai-feedback-test-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(request.body)).toEqual({
      chatbot_id: 'bot-feedback',
      browser_id: service.sessionId,
      rating: 'up',
      user_message: 'Hello',
      bot_response: 'Hi there',
      external_user_id: 'operator-a',
    });
  });

  test('does not forward without a HybridAI key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await setup({ chatbotId: 'bot-feedback' });
    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not forward without a bot id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await setup({ apiKey: 'hai-feedback-test-key' });
    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not forward when HybridAI auth is inactive', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    vi.stubGlobal('fetch', fetchMock);

    const service = await setup({
      apiKey: 'hai-feedback-test-key',
      authenticated: false,
      chatbotId: 'bot-feedback',
    });
    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects missing and non-assistant response identifiers', async () => {
    const service = await setup();

    expect(() =>
      service.submitResponseRating({
        sessionId: service.sessionId,
        messageId: 999_999,
        operatorUserId: 'operator-a',
        rating: 'up',
      }),
    ).toThrow('Response message was not found.');

    expect(() =>
      service.submitResponseRating({
        sessionId: service.sessionId,
        messageId: service.userMessageId,
        operatorUserId: 'operator-a',
        rating: 'up',
      }),
    ).toThrow('Only assistant responses can be rated.');
  });

  test('clears a selected rating', async () => {
    const service = await setup();

    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: 'up',
    });
    service.recordSkillFeedbackForObservation.mockClear();
    const cleared = service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: null,
    });

    expect(cleared.rating).toBeNull();
    expect(
      service.getResponseRatingsForMessages({
        sessionId: service.sessionId,
        messageIds: [service.assistantMessageId],
        operatorUserId: 'operator-a',
      }),
    ).toEqual(new Map());
    expect(service.recordSkillFeedbackForObservation).not.toHaveBeenCalled();
  });

  test('does not forward cleared ratings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = await setup({
      apiKey: 'hai-feedback-test-key',
      chatbotId: 'bot-feedback',
    });

    service.submitResponseRating({
      sessionId: service.sessionId,
      messageId: service.assistantMessageId,
      operatorUserId: 'operator-a',
      rating: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
