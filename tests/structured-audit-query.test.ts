import path from 'node:path';

import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

import type { WireRecord } from '../src/audit/audit-trail.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-structured-audit-query-',
});

test('getStructuredAuditForSession caps large sessions and warns once', async () => {
  setupHome();

  const {
    initDatabase,
    getStructuredAuditForSession,
    logStructuredAuditEvent,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  const sessionId = 'session-audit-cap';
  for (let index = 1; index <= 10_001; index += 1) {
    const record: WireRecord = {
      version: '2.0',
      seq: index,
      timestamp: new Date(index * 1000).toISOString(),
      runId: `run-${index}`,
      sessionId,
      event: {
        type: 'tool.result',
        toolName: 'bash',
        isError: false,
      },
      _prevHash: `prev-${index}`,
      _hash: `hash-${index}`,
    };
    logStructuredAuditEvent(record);
  }

  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  const rows = getStructuredAuditForSession(sessionId);

  stdoutSpy.mockRestore();

  expect(rows).toHaveLength(10_000);
  expect(rows[0]?.seq).toBe(1);
  expect(rows.at(-1)?.seq).toBe(10_000);
  const logOutput = writes.join('');
  expect(logOutput).toContain(
    'Structured audit query hit safety cap; returning truncated results',
  );
  expect(logOutput).toContain(sessionId);
  expect(logOutput).toContain('10000');
  expect(logOutput).toContain('10001');
});

test('listStructuredAuditEntries can prefix-match event type for type-ahead filters', async () => {
  setupHome();

  const { initDatabase, listStructuredAuditEntries, logStructuredAuditEvent } =
    await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  for (const [index, type] of [
    'usage.batch_flushed',
    'tool.result',
  ].entries()) {
    logStructuredAuditEvent({
      version: '2.0',
      seq: index + 1,
      timestamp: new Date((index + 1) * 1000).toISOString(),
      runId: `run-${index + 1}`,
      sessionId: 'session-audit-typeahead',
      event: { type },
      _prevHash: `prev-${index + 1}`,
      _hash: `hash-${index + 1}`,
    } satisfies WireRecord);
  }

  for (const eventType of ['u', 'usa', 'usage']) {
    expect(
      listStructuredAuditEntries({
        eventType,
        eventTypeMatch: 'prefix',
        limit: 10,
      }).map((entry) => entry.event_type),
    ).toEqual(['usage.batch_flushed']);
  }

  logStructuredAuditEvent({
    version: '2.0',
    seq: 3,
    timestamp: new Date(3000).toISOString(),
    runId: 'run-3',
    sessionId: 'session-audit-typeahead',
    event: { type: 'usage.batchXflushed' },
    _prevHash: 'prev-3',
    _hash: 'hash-3',
  } satisfies WireRecord);

  expect(
    listStructuredAuditEntries({
      eventType: 'usage.batch_',
      eventTypeMatch: 'prefix',
      limit: 10,
    }).map((entry) => entry.event_type),
  ).toEqual(['usage.batch_flushed']);

  expect(
    listStructuredAuditEntries({
      eventType: 'usage',
      limit: 10,
    }),
  ).toEqual([]);
});

test('structured audit writes and reads the unified actor surface', async () => {
  setupHome();

  const {
    getRecentStructuredAuditForSession,
    initDatabase,
    logStructuredAuditEvent,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  logStructuredAuditEvent({
    version: '2.0',
    seq: 1,
    timestamp: '2026-06-09T08:00:00.000Z',
    runId: 'run-actor',
    sessionId: 'session-actor',
    event: {
      type: 'operator.action',
      actor: { type: 'user', id: 'lena@hybridai' },
      action: 'review',
    },
    _prevHash: 'prev-actor',
    _hash: 'hash-actor',
  } satisfies WireRecord);

  const [entry] = getRecentStructuredAuditForSession('session-actor', 10);
  expect(entry?.actor_type).toBe('user');
  expect(entry?.actor_id).toBe('lena@hybridai');
  expect(JSON.parse(entry?.payload || '{}')).toEqual(
    expect.objectContaining({
      actor: { type: 'user', id: 'lena@hybridai' },
    }),
  );
});

test('migrateV43 backfills structured audit actors from legacy payload fields', async () => {
  const homeDir = setupHome();
  const dbPath = path.join(homeDir, 'hybridclaw.db');

  let { getRecentStructuredAuditForSession, initDatabase } = await import(
    '../src/memory/db.ts'
  );

  initDatabase({ quiet: true, dbPath });

  const legacy = new Database(dbPath);
  try {
    legacy
      .prepare(
        `INSERT INTO audit_events (
          session_id, seq, event_type, timestamp, run_id, parent_run_id, payload, wire_hash, wire_prev_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'session-legacy-actor',
        1,
        'operator.action',
        '2026-06-09T08:00:00.000Z',
        'run-legacy-actor',
        null,
        JSON.stringify({
          type: 'operator.action',
          userId: ' Lena@HybridAI ',
          action: 'review',
        }),
        'hash-legacy-actor',
        'prev-legacy-actor',
      );
    legacy.pragma('user_version = 42');
  } finally {
    legacy.close();
  }

  vi.resetModules();
  ({ getRecentStructuredAuditForSession, initDatabase } = await import(
    '../src/memory/db.ts'
  ));
  initDatabase({ quiet: true, dbPath });

  const [entry] = getRecentStructuredAuditForSession(
    'session-legacy-actor',
    10,
  );
  expect(entry?.actor_type).toBe('user');
  expect(entry?.actor_id).toBe('lena@hybridai');
  expect(JSON.parse(entry?.payload || '{}')).toEqual(
    expect.objectContaining({
      userId: ' Lena@HybridAI ',
      actor: { type: 'user', id: 'lena@hybridai' },
    }),
  );
});

test('actor data discovery returns sessions and audit rows for one Actor', async () => {
  setupHome();

  const {
    discoverActorData,
    getOrCreateSession,
    initDatabase,
    logStructuredAuditEvent,
    storeMessage,
  } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  getOrCreateSession(
    'session-user-actor-query',
    null,
    'dm:lena',
    'support@lena@inst-1',
  );
  storeMessage(
    'session-user-actor-query',
    'lena@hybridai',
    'Lena',
    'user',
    'Need a contract review.',
    'support@lena@inst-1',
  );
  logStructuredAuditEvent({
    version: '2.0',
    seq: 1,
    timestamp: '2026-06-09T08:00:00.000Z',
    runId: 'run-discovery',
    sessionId: 'session-user-actor-query',
    event: {
      type: 'operator.action',
      userId: 'lena@hybridai',
      action: 'review',
    },
    _prevHash: 'prev-discovery',
    _hash: 'hash-discovery',
  } satisfies WireRecord);

  const result = discoverActorData({
    actor: { type: 'user', id: 'lena@hybridai' },
    limit: 10,
  });

  expect(result.sessions.map((session) => session.sessionId)).toEqual([
    'session-user-actor-query',
  ]);
  expect(result.auditEvents).toHaveLength(1);
  expect(result.auditEvents[0]?.actor_type).toBe('user');
  expect(JSON.parse(result.auditEvents[0]?.payload || '{}')).toEqual(
    expect.objectContaining({
      userId: 'lena@hybridai',
      actor: { type: 'user', id: 'lena@hybridai' },
    }),
  );
});
