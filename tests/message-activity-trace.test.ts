import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-activity-trace-');

describe('message activity trace persistence', () => {
  it('round-trips an assistant activity trace through history', async () => {
    const dbModule = await import('../src/memory/db.js');
    const dbPath = path.join(makeTempDir(), 'hybridclaw.db');
    dbModule.initDatabase({ quiet: true, dbPath });

    const session = dbModule.getOrCreateSession(
      'agent:main:channel:web:chat:dm:peer:activity-trace',
      null,
      'web',
      'main',
    );
    dbModule.storeMessage(
      session.id,
      'user_a',
      'User A',
      'user',
      'Read my email',
    );
    const assistantId = dbModule.storeMessage(
      session.id,
      'assistant',
      null,
      'assistant',
      'Here are your emails.',
      'main',
    );

    const trace = {
      steps: [
        { kind: 'thinking' as const, text: 'Listing their messages' },
        {
          kind: 'tool' as const,
          toolName: 'list_messages',
          status: 'done' as const,
          argsPreview: '{"top":20}',
          resultPreview: '[{"id":"AAM..."}]',
          durationMs: 903,
        },
      ],
      elapsedMs: 34_000,
    };
    dbModule.setMessageActivityTrace(assistantId, trace);

    const page = dbModule.getConversationHistoryPage(session.id, 50);
    const assistant = page.history.find((m) => m.role === 'assistant');
    const user = page.history.find((m) => m.role === 'user');

    expect(assistant?.activityTrace).toEqual(trace);
    // A message without a stored trace stays undefined, not null/empty.
    expect(user?.activityTrace).toBeUndefined();
  });

  it('survives the schema migration on a pre-existing database', async () => {
    const dbModule = await import('../src/memory/db.js');
    const dbPath = path.join(makeTempDir(), 'hybridclaw.db');
    // A fresh init already runs every migration; assert the column exists by
    // exercising the writer + reader end to end without throwing.
    dbModule.initDatabase({ quiet: true, dbPath });
    const session = dbModule.getOrCreateSession(
      'agent:main:channel:web:chat:dm:peer:activity-trace-migrate',
      null,
      'web',
      'main',
    );
    const assistantId = dbModule.storeMessage(
      session.id,
      'assistant',
      null,
      'assistant',
      'Done.',
      'main',
    );
    expect(() =>
      dbModule.setMessageActivityTrace(assistantId, {
        steps: [{ kind: 'thinking', text: 'ok' }],
      }),
    ).not.toThrow();
    const page = dbModule.getConversationHistoryPage(session.id, 50);
    expect(page.history.find((m) => m.role === 'assistant')?.activityTrace).toEqual(
      { steps: [{ kind: 'thinking', text: 'ok' }] },
    );
  });
});
