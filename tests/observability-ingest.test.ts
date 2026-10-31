import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-observability-ingest-',
  envVars: ['HYBRIDAI_API_KEY'],
  cleanup: async () => {
    try {
      const { stopObservabilityIngest } = await import(
        '../src/audit/observability-ingest.ts'
      );
      stopObservabilityIngest();
    } catch {
      // Module may not have been loaded in this test.
    }
  },
});

async function observabilityTokenKey(): Promise<string> {
  const { resolveLocalInstanceId } = await import(
    '../src/identity/agent-id.ts'
  );
  return `https://hybridai.one/api/v1/agent-observability/ingest-token:ensure|${resolveLocalInstanceId()}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function okIngestResponse(insertedEvents = 1): Response {
  return Response.json({
    status: 'ok',
    inserted_events: insertedEvents,
    duplicate_events: 0,
    broken_chain_events: 0,
  });
}

async function configureObservabilityFixture(): Promise<void> {
  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    observability: {
      ...runtimeConfig.observability,
      enabled: true,
      flushIntervalMs: 60_000,
      batchMaxEvents: 10,
    },
  });
}

async function seedCachedObservabilityToken(
  token: string,
  updatedAt: string,
): Promise<void> {
  const { setObservabilityIngestToken, withMemoryDatabase } = await import(
    '../src/memory/db.ts'
  );
  const tokenKey = await observabilityTokenKey();
  setObservabilityIngestToken(tokenKey, token);
  withMemoryDatabase((database) => {
    database
      .prepare(
        `UPDATE observability_ingest_tokens
         SET updated_at = ?
         WHERE token_key = ?`,
      )
      .run(updatedAt, tokenKey);
  });
}

async function recordObservabilityBotSetEvent(
  sessionId: string,
  runId: string,
): Promise<void> {
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  recordAuditEvent({
    sessionId,
    runId,
    event: {
      type: 'bot.set',
      source: 'command',
      requestedBot: 'Research Bot',
      previousBotId: null,
      resolvedBotId: 'bot-research',
      changed: true,
      previousModel: 'gpt-5-nano',
      syncedModel: 'gpt-4o-mini',
      userId: 'user-1',
      username: 'alice',
    },
  });
  await flushAuditTrail();
}

test('observability ingest forwards audit events with no bot configured', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    observability: {
      ...runtimeConfig.observability,
      enabled: true,
      flushIntervalMs: 60_000,
      batchMaxEvents: 10,
    },
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
        return new Response(
          JSON.stringify({
            success: true,
            created: true,
            token: 'ingest-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/agent-observability/events:batch')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            inserted_events: 1,
            duplicate_events: 0,
            broken_chain_events: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const { startObservabilityIngest, stopObservabilityIngest } = await import(
    '../src/audit/observability-ingest.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-bot-set-observability',
    runId: 'cmd-bot-set-observability',
    event: {
      type: 'bot.set',
      source: 'command',
      requestedBot: 'Research Bot',
      previousBotId: null,
      resolvedBotId: 'bot-research',
      changed: true,
      previousModel: 'gpt-5-nano',
      syncedModel: 'gpt-4o-mini',
      userId: 'user-1',
      username: 'alice',
    },
  });

  await flushAuditTrail();

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  stopObservabilityIngest();

  const [, ingestCall] = fetchMock.mock.calls;
  const ingestUrl = String(ingestCall?.[0]);
  const ingestInit = ingestCall?.[1];
  const bodyText =
    typeof ingestInit?.body === 'string'
      ? ingestInit.body
      : String(ingestInit?.body ?? '');
  const payload = JSON.parse(bodyText) as {
    agent_id: string;
    events: Array<Record<string, unknown>>;
  };

  expect(ingestUrl).toContain('/api/v1/agent-observability/events:batch');
  expect(payload).not.toHaveProperty('bot_id');
  expect(payload.agent_id).toBe('main');
  expect(payload.events).toHaveLength(1);
  expect(payload.events[0]).toMatchObject({
    session_id: 'session-bot-set-observability',
    run_id: 'cmd-bot-set-observability',
    event_type: 'bot.set',
    payload: {
      type: 'bot.set',
      source: 'command',
      requestedBot: 'Research Bot',
      previousBotId: null,
      resolvedBotId: 'bot-research',
      changed: true,
      previousModel: 'gpt-5-nano',
      syncedModel: 'gpt-4o-mini',
      modelChanged: true,
      userId: 'user-1',
      username: 'alice',
    },
  });
});

test('observability ingest repairs unsafe unicode before posting events', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });
  await configureObservabilityFixture();

  let ingestedBody = '';
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
        return new Response(
          JSON.stringify({
            success: true,
            created: true,
            token: 'ingest-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/agent-observability/events:batch')) {
        ingestedBody =
          typeof init?.body === 'string'
            ? init.body
            : String(init?.body ?? '');
        return new Response(
          JSON.stringify({
            status: 'ok',
            inserted_events: 1,
            duplicate_events: 0,
            broken_chain_events: 0,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const { startObservabilityIngest, stopObservabilityIngest } = await import(
    '../src/audit/observability-ingest.ts'
  );

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-observability-unicode',
    runId: 'run-observability-unicode',
    event: {
      type: 'model.output',
      text: 'broken emoji \ud83e and tuple read\u001fpath',
      nested: {
        'bad\ud83ekey': ['still broken \ud83e', 'keep\tnewline\nok'],
      },
    },
  });

  await flushAuditTrail();

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  stopObservabilityIngest();

  expect(ingestedBody).not.toContain('\\ud83e');
  expect(ingestedBody).not.toContain('\\u001f');
  expect(ingestedBody).toContain('broken emoji � and tuple read�path');
  const payload = JSON.parse(ingestedBody) as {
    events: Array<{
      payload: {
        text: string;
        nested: Record<string, string[]>;
      };
    }>;
  };
  expect(payload.events[0]?.payload.text).toBe(
    'broken emoji � and tuple read�path',
  );
  expect(payload.events[0]?.payload.nested['bad�key']).toEqual([
    'still broken �',
    'keep\tnewline\nok',
  ]);
});

test('observability ingest reuses an old cached token and rotates only after ingest rejects it', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });
  await configureObservabilityFixture();

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
        const bodyText =
          typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
        expect(JSON.parse(bodyText)).toMatchObject({ rotate: true });
        return Response.json({
          success: true,
          rotated: true,
          token: 'fresh-ingest-token',
        });
      }
      if (url.endsWith('/api/v1/agent-observability/events:batch')) {
        const authorization = (init?.headers as Record<string, string>)
          .Authorization;
        if (authorization === 'Bearer revoked-ingest-token') {
          return Response.json({ message: 'Invalid token' }, { status: 401 });
        }
        expect(authorization).toBe('Bearer fresh-ingest-token');
        return Response.json({
          status: 'ok',
          inserted_events: 1,
          duplicate_events: 0,
          broken_chain_events: 0,
        });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase, getObservabilityIngestToken } = await import(
    '../src/memory/db.ts'
  );
  const { startObservabilityIngest, stopObservabilityIngest } = await import(
    '../src/audit/observability-ingest.ts'
  );

  initDatabase({ quiet: true });
  await seedCachedObservabilityToken(
    'revoked-ingest-token',
    '2000-01-01 00:00:00',
  );
  await recordObservabilityBotSetEvent(
    'session-observability-revoked-token',
    'run-observability-revoked-token',
  );

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  stopObservabilityIngest();

  expect(
    fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname),
  ).toEqual([
    '/api/v1/agent-observability/events:batch',
    '/api/v1/agent-observability/ingest-token:ensure',
    '/api/v1/agent-observability/events:batch',
  ]);
  expect(getObservabilityIngestToken(await observabilityTokenKey())).toBe(
    'fresh-ingest-token',
  );
});

test('observability ingest restart dispatches a new startup flush without waiting for an older push result', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    observability: {
      ...runtimeConfig.observability,
      enabled: true,
      label: 'node-a',
      flushIntervalMs: 60_000,
      batchMaxEvents: 10,
    },
  });

  let resolveFirstBatch: ((response: Response) => void) | null = null;
  const firstBatchResponse = new Promise<Response>((resolve) => {
    resolveFirstBatch = resolve;
  });

  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
        return new Response(
          JSON.stringify({
            success: true,
            created: true,
            token: 'ingest-token',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/v1/agent-observability/events:batch')) {
        const bodyText =
          typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
        const payload = JSON.parse(bodyText) as {
          label: string;
          agent_id: string;
        };
        if (payload.label === 'node-a') {
          return firstBatchResponse;
        }
        if (payload.label === 'node-b') {
          return new Response(
            JSON.stringify({
              status: 'ok',
              inserted_events: 1,
              duplicate_events: 0,
              broken_chain_events: 0,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  const {
    getObservabilityIngestState,
    startObservabilityIngest,
    stopObservabilityIngest,
  } = await import('../src/audit/observability-ingest.ts');
  const { initDatabase } = await import('../src/memory/db.ts');

  initDatabase({ quiet: true });
  recordAuditEvent({
    sessionId: 'session-bot-set-observability',
    runId: 'cmd-bot-set-observability',
    event: {
      type: 'bot.set',
      source: 'command',
      requestedBot: 'Research Bot',
      previousBotId: null,
      resolvedBotId: 'bot-research',
      changed: true,
      previousModel: 'gpt-5-nano',
      syncedModel: 'gpt-4o-mini',
      userId: 'user-1',
      username: 'alice',
    },
  });

  await flushAuditTrail();

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  saveRuntimeConfig({
    ...getRuntimeConfig(),
    observability: {
      ...getRuntimeConfig().observability,
      enabled: true,
      label: 'node-b',
      flushIntervalMs: 60_000,
      batchMaxEvents: 10,
    },
  });

  startObservabilityIngest();

  // The node's cached token survives the config change, so no second ensure call.
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  const secondBatchCall = fetchMock.mock.calls[2];
  const secondBatchBody =
    typeof secondBatchCall?.[1]?.body === 'string'
      ? secondBatchCall[1].body
      : String(secondBatchCall?.[1]?.body ?? '');
  const secondPayload = JSON.parse(secondBatchBody) as {
    label: string;
    agent_id: string;
  };
  expect(secondPayload).toMatchObject({
    label: 'node-b',
    agent_id: 'main',
  });

  resolveFirstBatch?.(
    new Response(
      JSON.stringify({
        status: 'ok',
        inserted_events: 1,
        duplicate_events: 0,
        broken_chain_events: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  );

  await vi.waitFor(() => {
    expect(getObservabilityIngestState().lastSuccessAt).not.toBeNull();
  });

  stopObservabilityIngest();
});

test('observability ingest sends one batch per agent, named after the session agent', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });
  await configureObservabilityFixture();

  const batches: Array<{ agent_id: string; runIds: string[] }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith('/ingest-token:ensure')) {
        return Response.json({ success: true, token: 'ingest-token' });
      }
      const payload = JSON.parse(String(init?.body)) as {
        agent_id: string;
        events: Array<{ run_id: string }>;
      };
      batches.push({
        agent_id: payload.agent_id,
        runIds: payload.events.map((event) => event.run_id),
      });
      return okIngestResponse(payload.events.length);
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const { initDatabase } = await import('../src/memory/db.ts');
  const { buildSessionKey } = await import('../src/session/session-key.ts');
  const { startObservabilityIngest, stopObservabilityIngest } = await import(
    '../src/audit/observability-ingest.ts'
  );
  initDatabase({ quiet: true });
  const alphaSession = buildSessionKey('alpha', 'web', 'dm', 'user_a');
  const betaSession = buildSessionKey('beta', 'web', 'dm', 'user_a');
  await recordObservabilityBotSetEvent(alphaSession, 'run-alpha-1');
  await recordObservabilityBotSetEvent(alphaSession, 'run-alpha-2');
  await recordObservabilityBotSetEvent(betaSession, 'run-beta-1');
  const { recordAuditEventStrict } = await import(
    '../src/audit/audit-events.js'
  );
  await recordAuditEventStrict({
    sessionId: betaSession,
    runId: 'run-alpha-in-beta-session',
    event: { type: 'session.start', executingAgentId: 'alpha' },
  });
  await recordAuditEventStrict({
    sessionId: betaSession,
    runId: 'run-alpha-in-beta-session',
    event: { type: 'tool.result', executingAgentId: 'unrelated-target' },
  });
  await recordObservabilityBotSetEvent('scheduler-maintenance', 'run-system');

  startObservabilityIngest();
  await vi.waitFor(() => {
    expect(batches).toHaveLength(4);
  });
  stopObservabilityIngest();

  expect(batches).toEqual([
    { agent_id: 'alpha', runIds: ['run-alpha-1', 'run-alpha-2'] },
    { agent_id: 'beta', runIds: ['run-beta-1'] },
    {
      agent_id: 'alpha',
      runIds: ['run-alpha-in-beta-session', 'run-alpha-in-beta-session'],
    },
    { agent_id: 'main', runIds: ['run-system'] },
  ]);
});

test.each(['current', 'legacy', 'other-node'] as const)(
  'observability ingest uses only its node cursor (%s)',
  async (cursorKind) => {
    setupHome({ HYBRIDAI_API_KEY: 'test-key' });
    await configureObservabilityFixture();

    const sentRunIds: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (requestUrl(input).endsWith('/ingest-token:ensure')) {
          return Response.json({ success: true, token: 'ingest-token' });
        }
        const payload = JSON.parse(String(init?.body)) as {
          events: Array<{ run_id: string }>;
        };
        sentRunIds.push(...payload.events.map((event) => event.run_id));
        return okIngestResponse(payload.events.length);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initDatabase, setObservabilityOffset, withMemoryDatabase } =
      await import('../src/memory/db.ts');
    const { startObservabilityIngest, stopObservabilityIngest } = await import(
      '../src/audit/observability-ingest.ts'
    );
    initDatabase({ quiet: true });
    await recordObservabilityBotSetEvent('session-legacy', 'run-already-sent');
    const lastSentId = withMemoryDatabase(
      (database) =>
        (
          database.prepare('SELECT MAX(id) AS id FROM audit_events').get() as {
            id: number;
          }
        ).id,
    );
    const { resolveLocalInstanceId } = await import('../src/identity/agent-id.ts');
    const cursorSuffixes = {
      current: resolveLocalInstanceId(),
      legacy: 'bot-observability|agent_main',
      'other-node': 'another-node',
    };
    setObservabilityOffset(
      `https://hybridai.one/api/v1/agent-observability/events:batch|${cursorSuffixes[cursorKind]}`,
      lastSentId,
    );
    await recordObservabilityBotSetEvent('session-legacy', 'run-new');

    startObservabilityIngest();
    await vi.waitFor(() => {
      expect(sentRunIds).toEqual(
        cursorKind === 'current' ? ['run-new'] : ['run-already-sent', 'run-new'],
      );
    });
    stopObservabilityIngest();
  },
);

test('observability ingest identifies the install with a node id that survives a restart', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });
  await configureObservabilityFixture();

  const ensuredNodeIds: string[] = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).endsWith('/ingest-token:ensure')) {
        const body = JSON.parse(String(init?.body)) as { node_id: string };
        ensuredNodeIds.push(body.node_id);
        return Response.json({ success: true, token: 'ingest-token' });
      }
      return okIngestResponse();
    },
  );
  vi.stubGlobal('fetch', fetchMock);

  const startAndEnsureToken = async (runId: string): Promise<void> => {
    vi.resetModules();
    const { initDatabase, deleteObservabilityIngestToken } = await import(
      '../src/memory/db.ts'
    );
    const { startObservabilityIngest, stopObservabilityIngest } = await import(
      '../src/audit/observability-ingest.ts'
    );
    initDatabase({ quiet: true });
    deleteObservabilityIngestToken(await observabilityTokenKey());
    await recordObservabilityBotSetEvent('session-node-id', runId);
    const ensuredBefore = ensuredNodeIds.length;
    startObservabilityIngest();
    await vi.waitFor(() => {
      expect(ensuredNodeIds).toHaveLength(ensuredBefore + 1);
    });
    stopObservabilityIngest();
  };

  await startAndEnsureToken('run-before-restart');
  await startAndEnsureToken('run-after-restart');

  expect(ensuredNodeIds[0]).toMatch(/^inst-[0-9a-f-]{36}$/);
  expect(ensuredNodeIds[1]).toBe(ensuredNodeIds[0]);
});

test('observability ingest rate-limits repeated transient outage warnings', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  const loggerMock = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  vi.doMock('../src/logger.ts', () => ({
    logger: loggerMock,
  }));

  try {
    const { getRuntimeConfig, saveRuntimeConfig } = await import(
      '../src/config/runtime-config.ts'
    );
    const runtimeConfig = getRuntimeConfig();
    saveRuntimeConfig({
      ...runtimeConfig,
      observability: {
        ...runtimeConfig.observability,
        enabled: true,
        flushIntervalMs: 10_000,
        batchMaxEvents: 10,
      },
    });

    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
          return new Response(
            JSON.stringify({
              success: true,
              created: true,
              token: 'ingest-token',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/api/v1/agent-observability/events:batch')) {
          throw new Error('fetch failed');
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initDatabase } = await import('../src/memory/db.ts');
    const { recordAuditEvent } = await import('../src/audit/audit-events.ts');
    const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
    const { startObservabilityIngest, stopObservabilityIngest } = await import(
      '../src/audit/observability-ingest.ts'
    );

    initDatabase({ quiet: true });
    recordAuditEvent({
      sessionId: 'session-observability-rate-limit',
      runId: 'run-observability-rate-limit',
      event: {
        type: 'bot.set',
        source: 'command',
        requestedBot: 'Research Bot',
        previousBotId: null,
        resolvedBotId: 'bot-research',
        changed: true,
        previousModel: 'gpt-5-nano',
        syncedModel: 'gpt-4o-mini',
        userId: 'user-1',
        username: 'alice',
      },
    });

    await flushAuditTrail();

    startObservabilityIngest();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    const transientWarnCalls = loggerMock.warn.mock.calls.filter(
      ([, message]) =>
        message ===
        'Observability ingest is temporarily unavailable at hybridai.one. Events will be retried automatically.',
    );
    expect(transientWarnCalls).toHaveLength(1);

    stopObservabilityIngest();
  } finally {
    vi.doUnmock('../src/logger.ts');
    vi.useRealTimers();
    vi.resetModules();
  }
});

test('observability ingest skips an event the server keeps failing to ingest', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  try {
    await configureObservabilityFixture();
    const ingestedRunIds: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/v1/agent-observability/ingest-token:ensure')) {
          return new Response(
            JSON.stringify({ success: true, token: 'ingest-token' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const payload = JSON.parse(String(init?.body)) as {
          events: Array<{ run_id: string }>;
        };
        const runIds = payload.events.map((event) => event.run_id);
        if (runIds.includes('run-poison')) {
          return new Response('{"error":"internal_error"}', { status: 500 });
        }
        ingestedRunIds.push(...runIds);
        return new Response(
          JSON.stringify({ status: 'accepted', inserted_events: runIds.length }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initDatabase } = await import('../src/memory/db.ts');
    const { startObservabilityIngest, stopObservabilityIngest } = await import(
      '../src/audit/observability-ingest.ts'
    );
    initDatabase({ quiet: true });
    for (const runId of ['run-0', 'run-1', 'run-poison', 'run-3']) {
      await recordObservabilityBotSetEvent('session-poison', runId);
    }

    startObservabilityIngest();
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.waitFor(() => {
      expect(ingestedRunIds).toEqual(['run-0', 'run-1', 'run-3']);
    });

    const batchPosts = () =>
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/events:batch'),
      ).length;
    const postsAfterCatchUp = batchPosts();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(batchPosts()).toBe(postsAfterCatchUp);

    stopObservabilityIngest();
  } finally {
    vi.useRealTimers();
    vi.resetModules();
  }
});

test('observability ingest stops requesting tokens once the API key is rejected', async () => {
  vi.useFakeTimers();
  vi.resetModules();
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  try {
    await configureObservabilityFixture();
    const fetchMock = vi.fn(async () =>
      Response.json({ message: 'Invalid API key' }, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { initDatabase } = await import('../src/memory/db.ts');
    const {
      getObservabilityIngestState,
      startObservabilityIngest,
      stopObservabilityIngest,
    } = await import('../src/audit/observability-ingest.ts');
    initDatabase({ quiet: true });
    await recordObservabilityBotSetEvent('session-rejected', 'run-rejected');

    startObservabilityIngest();
    await vi.waitFor(() => {
      expect(getObservabilityIngestState().paused).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/ingest-token:ensure',
    );

    stopObservabilityIngest();
  } finally {
    vi.useRealTimers();
    vi.resetModules();
  }
});
