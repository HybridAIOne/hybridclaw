import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-model-access-',
});

async function load() {
  setupHome();
  // No catalog: model names are taken as given, nothing is fetched.
  vi.doMock('../src/providers/model-catalog.js', async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../src/providers/model-catalog.js')
    >()),
    getAvailableModelList: vi.fn(() => []),
    refreshAvailableModelCatalogs: vi.fn(async () => {}),
  }));
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { DEVICE_TOKEN_ACTIONS, OWNER_DEVICE_TOKEN_ACTIONS } = await import(
    '../src/gateway/device-grants.ts'
  );
  const { getRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { getStoredAgentConfig } = await import(
    '../src/agents/agent-registry.ts'
  );
  initDatabase({ quiet: true });
  // A web turn, as the HTTP gateway hands it on with the caller's actions.
  const run = (args: string[], adminActions?: string[]) =>
    handleGatewayCommand({
      sessionId: 'web-chat',
      guildId: null,
      channelId: 'web',
      args,
      userId: 'web-user',
      adminActions,
    });
  return {
    run,
    phones: [[...DEVICE_TOKEN_ACTIONS], [...OWNER_DEVICE_TOKEN_ACTIONS]],
    defaultModel: () => getRuntimeConfig().hybridai.defaultModel,
    agentModel: () => getStoredAgentConfig('main')?.model,
  };
}

test('a phone changes the model of its own session, not the runtime default or the agent', async () => {
  const { run, phones, defaultModel, agentModel } = await load();
  const runtimeDefault = defaultModel();
  const savedAgentModel = agentModel();

  for (const phone of phones) {
    const setDefault = await run(['model', 'default', 'phone-model'], phone);
    expect(setDefault.title).toBe('Default Model Restricted');
    const setAgent = await run(['agent', 'model', 'phone-model'], phone);
    expect(setAgent.title).toBe('Agent Model Restricted');

    // Reading them and choosing this session's model still work.
    expect((await run(['model', 'default'], phone)).kind).toBe('info');
    expect((await run(['agent', 'model'], phone)).kind).toBe('info');
    expect((await run(['model', 'set', 'phone-model'], phone)).kind).not.toBe(
      'error',
    );
  }
  expect(defaultModel()).toBe(runtimeDefault);
  expect(agentModel()).toBe(savedAgentModel);
});

test('the local operator and a model admin still change the default and agent model', async () => {
  const { run, defaultModel, agentModel } = await load();

  expect((await run(['model', 'default', 'operator-model'])).kind).not.toBe(
    'error',
  );
  expect(defaultModel()).toBe('operator-model');
  expect((await run(['agent', 'model', 'operator-model'])).kind).toBe('info');
  expect(agentModel()).toBe('operator-model');

  expect(
    (await run(['model', 'default', 'admin-model'], ['admin.models.write']))
      .kind,
  ).not.toBe('error');
  expect(defaultModel()).toBe('admin-model');
  expect(
    (await run(['agent', 'model', 'admin-model'], ['admin.agents.write'])).kind,
  ).toBe('info');
  expect(agentModel()).toBe('admin-model');
});
