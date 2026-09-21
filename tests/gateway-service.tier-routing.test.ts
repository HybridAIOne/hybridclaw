import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock, evaluatorMock } = vi.hoisted(() => ({ runAgentMock: vi.fn(), evaluatorMock: vi.fn() }));
vi.mock('../src/gateway/routing-evaluator.ts', () => ({ evaluateConfiguredRouting: evaluatorMock }));

vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));

const ORIGINAL_HOME = process.env.HOME;
const makeTempHome = useTempDir('hybridclaw-tier-routing-home-');

async function createFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();

  const { initDatabase, updateSessionModel } = await import(
    '../src/memory/db.ts'
  );
  initDatabase({ quiet: true });
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  updateRuntimeConfig((draft) => {
    draft.local.backends.lmstudio.enabled = true;
    draft.routing.enabled = true;
    draft.routing.defaultStart = 'economy';
    draft.routing.escalationStickyTurns = 3;
    draft.routing.tiers = [
      { name: 'economy', models: ['lmstudio/test-cheap'] },
      { name: 'general', models: ['lmstudio/test-strong'] },
    ];
    draft.auxiliaryModels.session_title.provider = 'disabled';
  });
  const workspacePath = path.join(homeDir, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { getGatewaySessionContextUsage } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');
  return {
    getGatewaySessionContextUsage,
    handleGatewayMessage,
    homeDir,
    memoryService,
    updateRuntimeConfig,
    updateSessionModel,
    workspacePath,
  };
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    runAgentMock.mockReset();
    evaluatorMock.mockReset();
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  },
  resetModules: true,
});

test('session context reports automatic routing until a model is pinned', async () => {
  const fixture = await createFixture();
  const sessionId = 'session-tier-indicator';
  fixture.memoryService.getOrCreateSession(sessionId, null, 'web');

  expect(fixture.getGatewaySessionContextUsage(sessionId).routing).toEqual({
    active: true,
    showRoutingInfo: false,
    startTier: 'economy',
    startModel: 'lmstudio/test-cheap',
  });

  fixture.updateSessionModel(sessionId, 'lmstudio/pinned');

  expect(fixture.getGatewaySessionContextUsage(sessionId).routing).toEqual({
    active: false,
    showRoutingInfo: false,
    startTier: null,
    startModel: null,
  });
});

test('gateway escalates once, emits route telemetry, and hides failed deltas', async () => {
  const tokenUsage = {
    modelCalls: 1, apiUsageAvailable: true, apiPromptTokens: 10,
    apiCompletionTokens: 5, apiTotalTokens: 15,
    apiCacheUsageAvailable: true, apiCacheReadTokens: 2, apiCacheWriteTokens: 0,
    estimatedPromptTokens: 10, estimatedCompletionTokens: 5, estimatedTotalTokens: 15,
    costUsd: 0.01,
  };
  runAgentMock.mockImplementation(async (params) => {
    if (params.model === 'lmstudio/test-cheap') {
      params.onTextDelta?.('discarded failed output');
      return {
        status: 'error',
        result: '',
        error: 'Provider returned HTTP 503',
        tokenUsage,
        toolsUsed: [],
        toolExecutions: [],
      };
    }
    params.onTextDelta?.('successful output');
    return {
      status: 'success',
      result: 'successful output',
      tokenUsage,
      toolsUsed: [],
      toolExecutions: [],
    };
  });
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => { draft.routing.showRoutingInfo = true; });
  const deltas: string[] = [];
  const sessionId = 'session-tier-routing';
  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Complete the task.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
    onTextDelta: (delta) => deltas.push(delta),
  });

  expect(result).toMatchObject({
    status: 'success',
    result: 'successful output',
    model: 'lmstudio/test-strong',
  });
  expect(runAgentMock.mock.calls.map(([params]) => params.model)).toEqual([
    'lmstudio/test-cheap',
    'lmstudio/test-strong',
  ]);
  expect(deltas).toEqual(['successful output']);
  expect(result.routingTrace?.attempts.map((attempt) => attempt.model)).toEqual(['lmstudio/test-cheap', 'lmstudio/test-strong']);
  expect(result.routingTrace?.mode).toBe('tiered');
  const { flushTokenUsageBuffer } = await import('../src/usage/token-usage-buffer.ts');
  await flushTokenUsageBuffer();
  const { getSessionUsageTotals } = await import('../src/memory/db.ts');
  const usage = getSessionUsageTotals(sessionId);
  expect(result.routingTrace?.attempts.reduce((total, attempt) => total + (attempt.totalTokens ?? 0), 0)).toBe(usage.total_tokens);
  expect(result.routingTrace?.attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0)).toBeCloseTo(usage.total_cost_usd);
  expect(usage.total_cost_usd).toBeCloseTo(0.02);

  const { getGatewayHistory } = await import('../src/gateway/gateway-service.ts');
  expect(getGatewayHistory(sessionId).history.find((message) => message.id === result.assistantMessageId)?.routingTrace).toEqual(result.routingTrace);
  fixture.updateRuntimeConfig((draft) => { draft.routing.showRoutingInfo = false; });
  expect(getGatewayHistory(sessionId).history.find((message) => message.id === result.assistantMessageId)?.routingTrace).toBeUndefined();
  fixture.updateRuntimeConfig((draft) => { draft.routing.showRoutingInfo = true; });
  expect(getGatewayHistory(sessionId).history.find((message) => message.id === result.assistantMessageId)?.routingTrace).toEqual(result.routingTrace);


  runAgentMock.mockClear();
  await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Continue.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });
  expect(runAgentMock.mock.calls.map(([params]) => params.model)).toEqual([
    'lmstudio/test-strong',
  ]);

  const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
  const wire = fs
    .readFileSync(getAuditWirePath(sessionId), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    wire.filter((record) => record.event?.type === 'route.escalated'),
  ).toHaveLength(1);
  expect(
    wire.find((record) => record.event?.type === 'route.escalated')?.event,
  ).toMatchObject({
    fromTier: 'economy',
    toTier: 'general',
    reason: 'provider_server_error',
  });
  expect(
    wire.filter((record) => record.event?.type === 'model.usage'),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: expect.objectContaining({
          routeTier: 'economy',
          escalated: false,
        }),
      }),
      expect.objectContaining({
        event: expect.objectContaining({
          routeTier: 'general',
          escalated: true,
        }),
      }),
    ]),
  );
});

test('an explicit session model remains a hard pin', async () => {
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'pinned result',
    toolsUsed: [],
    toolExecutions: [],
  });
  const fixture = await createFixture();
  const sessionId = 'session-tier-pinned';
  fixture.memoryService.getOrCreateSession(sessionId, null, 'tui');
  fixture.updateSessionModel(sessionId, 'lmstudio/pinned');

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Use my pinned model.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(result.model).toBe('lmstudio/pinned');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0].model).toBe('lmstudio/pinned');
});

test('a heartbeat turn starts on the bottom rung', async () => {
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'heartbeat complete',
    toolsUsed: [],
    toolExecutions: [],
  });
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.defaultStart = 'general';
  });

  await fixture.handleGatewayMessage({
    sessionId: 'session-tier-heartbeat',
    guildId: null,
    channelId: 'heartbeat',
    userId: 'system',
    username: null,
    content: 'Run the heartbeat checklist.',
    chatbotId: 'bot_test',
    source: 'heartbeat',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(runAgentMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock.mock.calls[0]?.[0].model).toBe('lmstudio/test-cheap');
});

test('successive manual escalations advance from the last successful tier and stop at the top', async () => {
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.tiers.push({ name: 'advanced', models: ['lmstudio/test-frontier'] });
  });
  runAgentMock.mockResolvedValue({ status: 'success', result: 'Answer', toolsUsed: [], toolExecutions: [] });
  const { handleGatewayCommand } = await import('../src/gateway/gateway-service.ts');
  const { peekStickyModelRoutingTier } = await import('../src/gateway/model-routing-state.ts');
  const request = {
    sessionId: 'session-manual-escalation', guildId: null, channelId: 'tui',
    userId: 'user-1', username: 'user', content: 'Explain photosynthesis.',
    chatbotId: 'bot_test', workspacePathOverride: fixture.workspacePath,
  };
  await fixture.handleGatewayMessage(request);
  for (const tier of ['general', 'advanced', 'advanced']) {
    await handleGatewayCommand({ ...request, args: ['escalate'] });
    await fixture.handleGatewayMessage(request);
    expect(peekStickyModelRoutingTier(request.sessionId)).toBe(tier);
  }
  expect(runAgentMock.mock.calls.map(([params]) => params.model)).toEqual([
    'lmstudio/test-cheap', 'lmstudio/test-strong', 'lmstudio/test-frontier', 'lmstudio/test-frontier',
  ]);
});

test('does not remember an unsuccessful manual escalation', async () => {
  const fixture = await createFixture();
  runAgentMock.mockResolvedValue({ status: 'error', result: '', error: 'Provider returned HTTP 503', toolsUsed: [], toolExecutions: [] });
  const { handleGatewayCommand } = await import('../src/gateway/gateway-service.ts');
  const { peekStickyModelRoutingTier } = await import('../src/gateway/model-routing-state.ts');
  const request = {
    sessionId: 'session-manual-escalation-failed', guildId: null, channelId: 'tui',
    userId: 'user-1', username: 'user', content: 'Explain photosynthesis.',
    chatbotId: 'bot_test', workspacePathOverride: fixture.workspacePath,
  };
  await handleGatewayCommand({ ...request, args: ['escalate'] });
  const result = await fixture.handleGatewayMessage(request);
  expect(result.status).toBe('error');
  expect(runAgentMock.mock.calls.map(([params]) => params.model)).toEqual(['lmstudio/test-strong']);
  expect(peekStickyModelRoutingTier(request.sessionId)).toBeUndefined();
});

test.each(['shadow', 'active'] as const)('typed evaluator %s preserves or raises the configured start', async mode => {
  const fixture = await createFixture();
  fixture.updateRuntimeConfig(draft => { draft.routing.evaluator.mode = mode; draft.routing.showRoutingInfo = true; });
  evaluatorMock.mockResolvedValue({ version: 1, provider: 'jev', mode, status: 'evaluated', reason: 'capability-recommendation', model: 'jev-test', durationMs: 10, inputTokens: 5, outputTokens: 5, costUsd: null, distributions: null, recommendedTier: 'general', applied: false });
  runAgentMock.mockResolvedValue({ status: 'success', result: 'Answer', toolsUsed: [], toolExecutions: [] });
  const request = { sessionId: `session-eval-${mode}`, guildId: null, channelId: 'tui', userId: 'user-1', username: 'user', content: 'Explain photosynthesis.', chatbotId: 'bot_test', workspacePathOverride: fixture.workspacePath };
  const result = await fixture.handleGatewayMessage(request);
  expect(runAgentMock.mock.calls[0][0].model).toBe(mode === 'active' ? 'lmstudio/test-strong' : 'lmstudio/test-cheap');
  expect(result.routingTrace?.evaluation?.applied).toBe(mode === 'active');
  runAgentMock.mockClear();
  fixture.updateSessionModel(request.sessionId, 'lmstudio/test-cheap');
  const pinned = await fixture.handleGatewayMessage(request);
  expect(runAgentMock.mock.calls[0][0].model).toBe('lmstudio/test-cheap');
  expect(pinned.routingTrace?.evaluation?.applied).toBe(false);
});
