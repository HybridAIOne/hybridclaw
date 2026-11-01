import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));
vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-executing-agent-',
  envVars: ['HYBRIDAI_API_KEY'],
  cleanup: async () => {
    const { stopObservabilityIngest } = await import(
      '../src/audit/observability-ingest.js'
    );
    stopObservabilityIngest();
    runAgentMock.mockReset();
  },
});

test('run identity is scoped to its session and run and survives later agent changes', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.js');
  const { getAuditRunAgentId } = await import('../src/memory/audit.js');
  const { recordAuditEventStrict } = await import(
    '../src/audit/audit-events.js'
  );
  initDatabase({ quiet: true });
  for (const [sessionId, runId, executingAgentId] of [
    ['app-session', 'first-run', 'hy'],
    ['app-session', 'second-run', 'research'],
    ['other-session', 'first-run', 'other'],
  ]) {
    await recordAuditEventStrict({
      sessionId,
      runId,
      event: { type: 'session.start', executingAgentId },
    });
  }
  expect(getAuditRunAgentId('app-session', 'first-run')).toBe('hy');
  expect(getAuditRunAgentId('app-session', 'second-run')).toBe('research');
  expect(getAuditRunAgentId('other-session', 'first-run')).toBe('other');
  expect(getAuditRunAgentId('other-session', 'second-run')).toBeNull();
  for (const [index, executingAgentId] of [
    undefined,
    null,
    '',
    ' ',
    42,
    {},
  ].entries()) {
    const runId = `invalid-${index}`;
    await recordAuditEventStrict({
      sessionId: 'app-session',
      runId,
      event: { type: 'session.start', executingAgentId },
    });
    expect(getAuditRunAgentId('app-session', runId)).toBeNull();
  }
});

test.each([
  'main-0123456789abcdef0123456789abcdef-hy-0123456789ab',
  'agent:main:channel:web:chat:dm:peer:user_a',
])('exports the executing agent for each run in %s', async (sessionId) => {
  setupHome({ HYBRIDAI_API_KEY: 'test-key' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({})),
  );
  const { initDatabase, closeDatabase } = await import('../src/memory/db.js');
  const { getStructuredAuditAfterId } = await import('../src/memory/audit.js');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.js'
  );
  const { upsertRegisteredAgent } = await import(
    '../src/agents/agent-registry.js'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { flushAuditTrail, verifyAuditSessionChain } = await import(
    '../src/audit/audit-trail.js'
  );
  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.observability.enabled = true;
    draft.observability.batchMaxEvents = 1;
    draft.auxiliaryModels.session_title.provider = 'disabled';
  });
  upsertRegisteredAgent({ id: 'hy', displayName: 'Hy' });
  upsertRegisteredAgent({ id: 'research', displayName: 'Research' });
  runAgentMock
    .mockResolvedValueOnce({
      status: 'success',
      result: 'Done.',
      toolsUsed: ['read'],
      toolExecutions: [
        { name: 'read', arguments: '{}', result: 'Found it.', durationMs: 1 },
      ],
    })
    .mockRejectedValueOnce(new Error('Runner stopped'));

  const request = {
    sessionId,
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'User',
    model: 'hybridai/gpt-5-mini',
    chatbotId: 'bot_a',
    content: 'Check the notes.',
    client: 'mobile' as const,
  };
  expect(
    (await handleGatewayMessage({ ...request, agentId: 'hy' })).status,
  ).toBe('success');
  expect(
    (await handleGatewayMessage({ ...request, agentId: 'research' })).status,
  ).toBe('error');
  await flushAuditTrail();

  const runs = runAgentMock.mock.calls.map(([input]) => ({
    sessionId: input.sessionId as string,
    runId: input.runId as string,
    agentId: input.agentId as string,
  }));
  expect(runs.map((run) => run.agentId)).toEqual(['hy', 'research']);
  const rows = getStructuredAuditAfterId(0, 5000);
  for (const run of runs) {
    const start = rows.find(
      (row) => row.run_id === run.runId && row.event_type === 'session.start',
    );
    expect(JSON.parse(start!.payload)).toMatchObject({
      executingAgentId: run.agentId,
    });
    expect((await verifyAuditSessionChain(run.sessionId)).ok).toBe(true);
  }

  // Export later, with no live turn state, and across separate one-event batches.
  closeDatabase();
  initDatabase({ quiet: true });
  const exported: Array<{ agentId: string; runId: string; type: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith('/ingest-token:ensure')) {
        return Response.json({ success: true, token: 'ingest-token' });
      }
      if (!url.endsWith('/events:batch')) return Response.json({});
      const batch = JSON.parse(String(init?.body)) as {
        agent_id: string;
        events: Array<{ run_id: string; event_type: string }>;
      };
      exported.push(
        ...batch.events.map((event) => ({
          agentId: batch.agent_id,
          runId: event.run_id,
          type: event.event_type,
        })),
      );
      return Response.json({
        status: 'ok',
        inserted_events: batch.events.length,
        duplicate_events: 0,
        broken_chain_events: 0,
      });
    }),
  );
  const { startObservabilityIngest, stopObservabilityIngest } = await import(
    '../src/audit/observability-ingest.js'
  );
  startObservabilityIngest();
  await vi.waitFor(() => expect(exported).toHaveLength(rows.length));
  stopObservabilityIngest();
  for (const run of runs) {
    const events = exported.filter((event) => event.runId === run.runId);
    expect(events.length).toBeGreaterThan(2);
    expect(new Set(events.map((event) => event.agentId))).toEqual(
      new Set([run.agentId]),
    );
    expect(events.map((event) => event.type)).toContain('turn.end');
  }
  expect(exported.some((event) => event.type === 'tool.result')).toBe(true);
});
