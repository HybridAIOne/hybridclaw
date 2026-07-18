import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

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
  const { memoryService } = await import('../src/memory/memory-service.ts');
  return {
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
    if (ORIGINAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = ORIGINAL_HOME;
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  },
  resetModules: true,
});

test('gateway escalates once, emits route telemetry, and hides failed deltas', async () => {
  runAgentMock.mockImplementation(async (params) => {
    if (params.model === 'lmstudio/test-cheap') {
      params.onTextDelta?.('discarded failed output');
      return {
        status: 'error',
        result: '',
        error: 'Provider returned HTTP 503',
        toolsUsed: [],
        toolExecutions: [],
      };
    }
    params.onTextDelta?.('successful output');
    return {
      status: 'success',
      result: 'successful output',
      toolsUsed: [],
      toolExecutions: [],
    };
  });
  const fixture = await createFixture();
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
