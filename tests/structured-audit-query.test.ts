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

  expect(
    listStructuredAuditEntries({
      eventType: 'usage',
      limit: 10,
    }),
  ).toEqual([]);
});
