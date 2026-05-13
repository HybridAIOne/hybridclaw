import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-concierge-command-',
});

function enableConciergePlugin(
  updateRuntimeConfig: typeof import('../src/config/runtime-config.js').updateRuntimeConfig,
): void {
  updateRuntimeConfig((draft) => {
    draft.plugins.list = [
      {
        id: 'concierge-router',
        enabled: true,
        path: './plugins/concierge-router',
        config: {},
      },
    ];
  });
}

test('concierge info reports config and on/off toggles persisted runtime state', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  enableConciergePlugin(updateRuntimeConfig);

  const info = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'info'],
  });

  expect(info.kind).toBe('info');
  if (info.kind !== 'info') {
    throw new Error(`Unexpected result kind: ${info.kind}`);
  }
  expect(info.text).toContain('Enabled: off');
  expect(info.text).toContain('Decision model: hybridai/gemini-3-flash');

  const enabled = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'on'],
  });

  expect(enabled.kind).toBe('plain');
  expect(enabled.text).toContain('Concierge routing enabled');
  expect(getRuntimeConfig().plugins.list[0]?.config.enabled).toBe(true);

  const disabled = await handleGatewayCommand({
    sessionId: 'session-concierge-command-info',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'off'],
  });

  expect(disabled.kind).toBe('plain');
  expect(disabled.text).toContain('Concierge routing disabled');
  expect(getRuntimeConfig().plugins.list[0]?.config.enabled).toBe(false);
});

test('concierge command updates the decision model and profile mappings', async () => {
  setupHome();

  vi.doMock('../src/providers/model-catalog.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/providers/model-catalog.js')
    >('../src/providers/model-catalog.js');
    return {
      ...actual,
      refreshAvailableModelCatalogs: vi.fn(async () => {}),
      getAvailableModelList: vi.fn(() => [
        'hybridai/gpt-5',
        'hybridai/gpt-5-mini',
      ]),
    };
  });
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get: vi.fn(async () => ({
        reachable: true,
        latencyMs: 10,
        modelCount: 2,
      })),
      peek: vi.fn(() => null),
      invalidate: vi.fn(),
    },
  }));
  vi.doMock('../src/providers/local-health.js', () => ({
    localBackendsProbe: {
      get: vi.fn(async () => new Map()),
      peek: vi.fn(() => new Map()),
      invalidate: vi.fn(),
    },
    checkConnection: vi.fn(),
    checkModelConnection: vi.fn(),
    checkAllBackends: vi.fn(async () => new Map()),
  }));

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  enableConciergePlugin(updateRuntimeConfig);

  const modelResult = await handleGatewayCommand({
    sessionId: 'session-concierge-command-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'model', 'gpt-5'],
  });

  expect(modelResult.kind).toBe('plain');
  expect(modelResult.text).toContain('Concierge decision model set');
  expect(getRuntimeConfig().plugins.list[0]?.config.model).toBe('gpt-5');

  const profileResult = await handleGatewayCommand({
    sessionId: 'session-concierge-command-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'no_hurry', 'gpt-5-mini'],
  });

  expect(profileResult.kind).toBe('plain');
  expect(profileResult.text).toContain('Concierge profile `no_hurry` set');
  expect(
    (getRuntimeConfig().plugins.list[0]?.config.profiles as { noHurry?: string })
      .noHurry,
  ).toBe('gpt-5-mini');
});

test('concierge command rejects unknown profile names', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import('../src/config/runtime-config.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  enableConciergePlugin(updateRuntimeConfig);

  const result = await handleGatewayCommand({
    sessionId: 'session-concierge-command-invalid',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'later'],
  });

  expect(result.kind).toBe('error');
  expect(result.text).toContain(
    'Usage: `concierge profile <asap|balanced|no_hurry> [model]`',
  );
});

test('concierge command accepts raw model names in plugin config', async () => {
  setupHome();

  const { initDatabase } = await import('../src/memory/db.ts');
  const { getRuntimeConfig, updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  initDatabase({ quiet: true });
  enableConciergePlugin(updateRuntimeConfig);

  const decisionModel = await handleGatewayCommand({
    sessionId: 'session-concierge-command-unknown-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'model', 'definitely-not-a-real-model'],
  });

  expect(decisionModel.kind).toBe('plain');
  expect(getRuntimeConfig().plugins.list[0]?.config.model).toBe(
    'definitely-not-a-real-model',
  );

  const profileModel = await handleGatewayCommand({
    sessionId: 'session-concierge-command-unknown-model',
    guildId: null,
    channelId: 'web',
    args: ['concierge', 'profile', 'balanced', 'definitely-not-a-real-model'],
  });

  expect(profileModel.kind).toBe('plain');
  expect(
    (getRuntimeConfig().plugins.list[0]?.config.profiles as {
      balanced?: string;
    }).balanced,
  ).toBe('definitely-not-a-real-model');
});
