import { expect, test } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-observability-base-url-',
  envVars: ['HYBRIDAI_BASE_URL'],
});

test('observability baseUrl follows HYBRIDAI_BASE_URL from the environment', async () => {
  setupHome({ HYBRIDAI_BASE_URL: 'https://platform.example.test/' });

  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');

  expect(getRuntimeConfig().observability.baseUrl).toBe(
    'https://platform.example.test',
  );
});

test('an explicit observability baseUrl wins over the environment', async () => {
  setupHome({ HYBRIDAI_BASE_URL: 'https://platform.example.test' });

  const { getRuntimeConfig, saveRuntimeConfig, reloadRuntimeConfig } =
    await import('../src/config/runtime-config.ts');
  const runtimeConfig = getRuntimeConfig();
  saveRuntimeConfig({
    ...runtimeConfig,
    observability: {
      ...runtimeConfig.observability,
      baseUrl: 'https://observability.example.test',
    },
  });

  expect(reloadRuntimeConfig().observability.baseUrl).toBe(
    'https://observability.example.test',
  );
});

test('observability baseUrl keeps the hybridai config default without env', async () => {
  setupHome();
  delete process.env.HYBRIDAI_BASE_URL;

  const { getRuntimeConfig } = await import('../src/config/runtime-config.ts');

  expect(getRuntimeConfig().observability.baseUrl).toBe(
    getRuntimeConfig().hybridai.baseUrl,
  );
});
