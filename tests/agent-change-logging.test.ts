import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const ORIGINAL_HOME = process.env.HOME;

const makeTempHome = useTempDir('hybridclaw-agent-logs-');

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: async () => {
    const { resetAgentRegistryForTesting } = await import(
      '../src/agents/agent-registry.ts'
    );
    resetAgentRegistryForTesting();
    restoreEnvVar('HOME', ORIGINAL_HOME);
  },
  resetModules: true,
  unmock: ['../src/logger.js'],
});

test('agent upserts log field-level changes with revision attribution', async () => {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { getStoredAgentConfig, initAgentRegistry, upsertRegisteredAgent } =
    await import('../src/agents/agent-registry.ts');
  const { logger } = await import('../src/logger.js');
  const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

  const configuredList = [
    { id: 'main', name: 'Main Agent' },
    { id: 'gateway', name: 'Gateway Agent', model: 'gpt-5-mini' },
  ];

  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.agents.list = configuredList;
  });
  initAgentRegistry({ list: configuredList });

  const createdCalls = infoSpy.mock.calls.filter(
    ([, message]) => message === 'Agent created',
  );
  expect(createdCalls.map(([payload]) => payload)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        agentId: 'gateway',
        route: 'agents.team.config_sync',
        source: 'agent-registry',
      }),
    ]),
  );

  // Re-running the same sync must stay silent — this path fires on every
  // gateway boot for every agent.
  infoSpy.mockClear();
  initAgentRegistry({ list: configuredList });
  expect(
    infoSpy.mock.calls.filter(
      ([, message]) =>
        message === 'Agent settings updated' || message === 'Agent created',
    ),
  ).toEqual([]);

  // A runtime edit logs which fields changed and who asked.
  infoSpy.mockClear();
  upsertRegisteredAgent({
    ...getStoredAgentConfig('gateway')!,
    chatbotId: 'bot-gateway',
    proxy: {
      kind: 'hybridai',
      baseUrl: 'https://hybridai.example',
      chatbotId: 'bot-proxy',
      apiKey: { source: 'store', id: 'HYBRIDAI_API_KEY' },
    },
  });
  const updatedCalls = infoSpy.mock.calls.filter(
    ([, message]) => message === 'Agent settings updated',
  );
  expect(updatedCalls).toHaveLength(1);
  expect(updatedCalls[0]?.[0]).toEqual(
    expect.objectContaining({
      agentId: 'gateway',
      changedFields: expect.arrayContaining(['chatbotId', 'proxy']),
      route: 'agents.team.upsert#gateway',
      source: 'agent-registry',
    }),
  );
  expect(updatedCalls[0]?.[0]).not.toHaveProperty('clearedFields');

  // Clearing a setting is called out explicitly.
  infoSpy.mockClear();
  const { proxy: _cleared, ...storedWithoutProxy } =
    getStoredAgentConfig('gateway')!;
  upsertRegisteredAgent(storedWithoutProxy);
  const clearedCalls = infoSpy.mock.calls.filter(
    ([, message]) => message === 'Agent settings updated',
  );
  expect(clearedCalls).toHaveLength(1);
  expect(clearedCalls[0]?.[0]).toEqual(
    expect.objectContaining({
      agentId: 'gateway',
      changedFields: ['proxy'],
      clearedFields: ['proxy'],
    }),
  );

  // Log payloads must never include setting values, only field names.
  for (const [payload] of [...updatedCalls, ...clearedCalls]) {
    expect(JSON.stringify(payload)).not.toContain('bot-proxy');
    expect(JSON.stringify(payload)).not.toContain('HYBRIDAI_API_KEY');
  }
});
