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
    draft.routing.target = { quality: 0, speed: 0 };
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

test('sovereignty exhaustion raises F14 and makes zero model calls', async () => {
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.sovereignty = 'local';
    draft.routing.tiers = [
      { name: 'economy', models: ['gpt-5-mini'] },
      { name: 'general', models: ['gpt-5'] },
    ];
  });

  const sessionId = 'session-tier-sovereignty-exhausted';
  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Keep this local.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: 'success',
    messageRole: 'approval',
    routing: {
      exhausted: true,
      attempts: 0,
      sovereignty: 'local',
    },
  });

  const { getSuspendedSession } = await import(
    '../src/gateway/interactive-escalation.ts'
  );
  expect(getSuspendedSession(sessionId)).toMatchObject({
    status: 'pending',
    context: { pageTitle: 'F14 policy escalation' },
  });
  const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
  const wire = fs
    .readFileSync(getAuditWirePath(sessionId), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(wire.some((record) => record.event?.type === 'route.exhausted')).toBe(
    true,
  );
  expect(
    wire.some(
      (record) => record.event?.type === 'escalation.interaction_needed',
    ),
  ).toBe(true);
  expect(
    wire.some((record) => record.event?.type === 'browser.escalation_2fa'),
  ).toBe(false);
});

test('hai sovereignty never records a model usage event above hai', async () => {
  const allowedZones = new Set(['local', 'hai']);
  for (const quality of [0, 0.5, 1]) {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue({
      status: 'success',
      result: 'policy-compliant output',
      toolsUsed: [],
      toolExecutions: [],
    });
    const fixture = await createFixture();
    fixture.updateRuntimeConfig((draft) => {
      draft.local.endpoints = [
        {
          name: 'haigpu',
          type: 'vllm',
          enabled: true,
          baseUrl: 'http://haigpu:8000/v1',
          zone: 'hai',
        },
      ];
      draft.routing.sovereignty = 'hai';
      draft.routing.target = { quality, speed: 0 };
      draft.routing.tiers = [
        { name: 'economy', models: ['lmstudio/test-cheap'] },
        { name: 'general', models: ['haigpu/test-mid'] },
        { name: 'advanced', models: ['hybridai/gpt-5'] },
      ];
    });
    const sessionId = `session-tier-sovereignty-hai-${quality}`;

    await fixture.handleGatewayMessage({
      sessionId,
      guildId: null,
      channelId: 'tui',
      userId: 'user-1',
      username: 'user',
      content: 'Keep this at or below HAI.',
      chatbotId: 'bot_test',
      workspacePathOverride: fixture.workspacePath,
    });

    const { getAuditWirePath } = await import('../src/audit/audit-trail.ts');
    const usageEvents = fs
      .readFileSync(getAuditWirePath(sessionId), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((record) => record.event?.type === 'model.usage');
    if (quality < 1) expect(usageEvents).toHaveLength(1);
    for (const record of usageEvents) {
      expect(allowedZones.has(record.event.routeZone)).toBe(true);
    }
    expect(
      runAgentMock.mock.calls.every(
        ([params]) => params.model !== 'hybridai/gpt-5',
      ),
    ).toBe(true);
  }
});

test('an invoked skill applies its minimum tier and sensitivity policy', async () => {
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'skill-routed output',
    toolsUsed: [],
    toolExecutions: [],
  });
  const fixture = await createFixture();
  const skillsRoot = path.join(fixture.homeDir, 'routing-skills');
  const skillDir = path.join(skillsRoot, 'secure-work');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---
name: secure-work
description: Route secure work through the declared policy.
user-invocable: true
routing:
  minTier: general
  sensitivity: restricted
---

# Secure work
`,
    'utf-8',
  );
  fixture.updateRuntimeConfig((draft) => {
    draft.skills.extraDirs = [skillsRoot];
  });

  const result = await fixture.handleGatewayMessage({
    sessionId: 'session-tier-skill-policy',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: '/secure-work Complete the task.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(result).toMatchObject({
    status: 'success',
    model: 'lmstudio/test-strong',
    routing: {
      startTier: 'general',
      sovereignty: 'local',
    },
  });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
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

test('a hard pin cannot bypass the sovereignty ceiling', async () => {
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.sovereignty = 'local';
  });
  const sessionId = 'session-tier-pinned-sovereignty';
  fixture.memoryService.getOrCreateSession(sessionId, null, 'tui');
  fixture.updateSessionModel(sessionId, 'hybridai/gpt-5');

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Use the pinned cloud model.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(runAgentMock).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    messageRole: 'approval',
    routing: {
      reason: 'pinned-model-sovereignty',
      exhausted: true,
      attempts: 0,
    },
  });
});

test('the opt-in budget clamp lowers the selected maximum tier', async () => {
  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'budget-aware output',
    toolsUsed: [],
    toolExecutions: [],
  });
  const fixture = await createFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.routing.budgetClamp = { enabled: true };
    draft.routing.target = { quality: 1, speed: 0 };
    draft.agents.list = [
      {
        id: 'main',
        budget: { cap: 100, currency: 'USD', unit: 'tokens' },
      },
    ];
  });
  const { recordUsageEvent } = await import('../src/memory/db.ts');
  recordUsageEvent({
    sessionId: 'prior-budget-usage',
    agentId: 'main',
    model: 'lmstudio/test-cheap',
    inputTokens: 40,
    outputTokens: 20,
    totalTokens: 60,
  });

  const result = await fixture.handleGatewayMessage({
    sessionId: 'session-tier-budget-clamp',
    guildId: null,
    channelId: 'tui',
    userId: 'user-1',
    username: 'user',
    content: 'Respect the remaining budget.',
    chatbotId: 'bot_test',
    workspacePathOverride: fixture.workspacePath,
  });

  expect(result).toMatchObject({
    status: 'success',
    model: 'lmstudio/test-cheap',
    routing: { startTier: 'economy', finalTier: 'economy' },
  });
  expect(runAgentMock).toHaveBeenCalledTimes(1);
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
