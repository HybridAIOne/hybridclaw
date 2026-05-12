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

test('observability ingest forwards bot.set audit events to HybridAI', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    hybridai: {
      ...runtimeConfig.hybridai,
      defaultChatbotId: 'bot-default',
    },
    observability: {
      ...runtimeConfig.observability,
      enabled: true,
      botId: 'bot-observability',
      agentId: 'agent-observability',
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
    bot_id: string;
    agent_id: string;
    events: Array<Record<string, unknown>>;
  };

  expect(ingestUrl).toContain('/api/v1/agent-observability/events:batch');
  expect(payload.bot_id).toBe('bot-observability');
  expect(payload.agent_id).toBe('agent-observability');
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

test('observability ingest restart dispatches a new startup flush without waiting for an older push result', async () => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });

  const { getRuntimeConfig, saveRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    hybridai: {
      ...runtimeConfig.hybridai,
      defaultChatbotId: 'bot-default',
    },
    observability: {
      ...runtimeConfig.observability,
      enabled: true,
      botId: 'bot-a',
      agentId: 'agent-a',
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
          bot_id: string;
          agent_id: string;
        };
        if (payload.bot_id === 'bot-a') {
          return firstBatchResponse;
        }
        if (payload.bot_id === 'bot-b') {
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

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  saveRuntimeConfig({
    ...getRuntimeConfig(),
    observability: {
      ...getRuntimeConfig().observability,
      enabled: true,
      botId: 'bot-b',
      agentId: 'agent-b',
      flushIntervalMs: 60_000,
      batchMaxEvents: 10,
    },
  });

  startObservabilityIngest();

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(getObservabilityIngestState().streamKey).toContain('bot-b');
  });

  const secondBatchCall = fetchMock.mock.calls[3];
  const secondBatchBody =
    typeof secondBatchCall?.[1]?.body === 'string'
      ? secondBatchCall[1].body
      : String(secondBatchCall?.[1]?.body ?? '');
  const secondPayload = JSON.parse(secondBatchBody) as {
    bot_id: string;
    agent_id: string;
  };
  expect(secondPayload).toMatchObject({
    bot_id: 'bot-b',
    agent_id: 'agent-b',
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
    expect(getObservabilityIngestState().streamKey).toContain('bot-b');
    expect(getObservabilityIngestState().lastSuccessAt).not.toBeNull();
  });

  stopObservabilityIngest();
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
      hybridai: {
        ...runtimeConfig.hybridai,
        defaultChatbotId: 'bot-default',
      },
      observability: {
        ...runtimeConfig.observability,
        enabled: true,
        botId: 'bot-observability',
        agentId: 'agent-observability',
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
