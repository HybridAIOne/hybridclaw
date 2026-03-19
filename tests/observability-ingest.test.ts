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
