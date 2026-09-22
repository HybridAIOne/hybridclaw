import { expect, test } from 'vitest';
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

test.each([{ args: [] }, { args: ['info'] }])(
  'concierge %j reports shared routing configuration',
  async ({ args }) => {
    setupHome();
    const { initDatabase } = await import('../src/memory/db.ts');
    const { updateRuntimeConfig } = await import(
      '../src/config/runtime-config.ts'
    );
    const { handleGatewayCommand } = await import(
      '../src/gateway/gateway-service.ts'
    );
    initDatabase({ quiet: true });
    enableConciergePlugin(updateRuntimeConfig);

    const result = await handleGatewayCommand({
      sessionId: 'session-concierge-info',
      guildId: null,
      channelId: 'web',
      args: ['concierge', ...args],
    });
    expect(result.kind).toBe('plain');
    expect(result.text).toContain('Routing: off');
    expect(result.text).toContain('Concierge: none');
    expect(result.text).toContain('/admin/model-routing');
    expect(result.text).not.toContain('undefined');
  },
);

test.each([
  ['on'],
  ['off'],
  ['model', 'unknown-model'],
  ['profile', 'no_hurry', 'unknown-model'],
  ['profile', 'later'],
])(
  'concierge %j directs configuration to admin without changing state',
  async (...args) => {
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
    const before = structuredClone(getRuntimeConfig());

    const result = await handleGatewayCommand({
      sessionId: 'session-concierge-config',
      guildId: null,
      channelId: 'web',
      args: ['concierge', ...args],
    });
    expect(result.kind).toBe('plain');
    expect(result.text).toBe('Configure routing in /admin/model-routing.');
    expect(getRuntimeConfig()).toEqual(before);
  },
);
