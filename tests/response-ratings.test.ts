import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-response-ratings-');

useCleanMocks({
  resetModules: true,
  unmock: [
    '../src/audit/audit-events.js',
    '../src/skills/skills-observation.js',
  ],
});

async function setup() {
  const recordAuditEvent = vi.fn();
  const recordSkillFeedbackForObservation = vi.fn();
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId: () => 'rating_run',
    recordAuditEvent,
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
});
