import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { cleanupGatewayRuntime } from './helpers/gateway-test-setup.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const temporary = useTempDir('nebius-provider-');
useCleanMocks({
  cleanup: cleanupGatewayRuntime,
  resetModules: true,
  unstubAllEnvs: true,
  unstubAllGlobals: true,
});

async function configure() {
  const root = temporary();
  vi.stubEnv('HOME', root);
  vi.stubEnv('HYBRIDCLAW_DATA_DIR', root);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.stubEnv('NEBIUS_API_KEY', '');
  vi.resetModules();
  const config = await import('../src/config/runtime-config.js');
  config.updateRuntimeConfig((draft) => {
    draft.nebius.enabled = true;
  });
  return config;
}

test('Nebius resolves as a cloud provider using its encrypted credential', async () => {
  const config = await configure();
  const secrets = await import('../src/security/runtime-secrets.js');
  secrets.saveRuntimeSecrets({ NEBIUS_API_KEY: 'test-key' });
  expect(secrets.isRuntimeSecretKey('NEBIUS_API_KEY')).toBe(true);
  expect(fs.readFileSync(secrets.runtimeSecretsPath(), 'utf8')).not.toContain(
    'test-key',
  );
  expect(fs.statSync(secrets.runtimeSecretsPath()).mode & 0o777).toBe(0o600);
  const model = config.DEFAULT_RUNTIME_CONFIG.nebius.models[0];
  const factory = await import('../src/providers/factory.js');
  const runtime = await factory.resolveModelRuntimeCredentials({ model });
  expect(factory.resolveModelProvider(model)).toBe('nebius');
  expect(runtime).toMatchObject({
    provider: 'nebius',
    model,
    apiKey: 'test-key',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    isLocal: false,
    enableRag: false,
  });
  const { getModelCatalogMetadata } = await import(
    '../src/providers/model-catalog.js'
  );
  expect(getModelCatalogMetadata(model).zone).toBe('cloud');
});

test('a missing Nebius key cannot use another provider credential', async () => {
  const config = await configure();
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  const { resolveModelRuntimeCredentials } = await import(
    '../src/providers/factory.js'
  );
  await expect(
    resolveModelRuntimeCredentials({
      model: config.DEFAULT_RUNTIME_CONFIG.nebius.models[0],
    }),
  ).rejects.toMatchObject({ envVar: 'NEBIUS_API_KEY' });
});

test('Nebius discovery and transport preserve namespaced model IDs and native tool calls', async () => {
  const config = await configure();
  vi.stubEnv('NEBIUS_API_KEY', 'test-key');
  const model = config.DEFAULT_RUNTIME_CONFIG.nebius.models[0];
  const nativeModel = model.slice('nebius/'.length);
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer test-key',
    );
    if (String(url).endsWith('/models'))
      return Response.json({ data: [{ id: nativeModel }] });
    expect(String(url)).toBe(
      'https://api.tokenfactory.nebius.com/v1/chat/completions',
    );
    const request = JSON.parse(String(init?.body));
    expect(request.model).toBe(nativeModel);
    expect(request.tools[0].function.name).toBe('read');
    return Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_sample',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: '{"path":"sample.txt"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const { getOpenAICompatRemoteProviderDef } = await import(
    '../src/providers/openai-compat-remote.js'
  );
  const { createOpenAICompatDiscoveryStore } = await import(
    '../src/providers/openai-compat-discovery.js'
  );
  const definition = getOpenAICompatRemoteProviderDef('nebius');
  const discovery = createOpenAICompatDiscoveryStore(
    definition,
    definition.readEnabled,
  );
  await expect(discovery.discoverModels()).resolves.toEqual([model]);
  const { resolveModelRuntimeCredentials } = await import(
    '../src/providers/factory.js'
  );
  const runtime = await resolveModelRuntimeCredentials({ model });
  const { callRoutedModel } = await import(
    '../container/src/providers/router.js'
  );
  const response = await callRoutedModel({
    ...runtime,
    messages: [{ role: 'user', content: 'Read the neutral sample.' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file.',
          parameters: { type: 'object' },
        },
      },
    ],
    maxTokens: 128,
  });
  expect(response.choices[0].message.tool_calls).toMatchObject([
    {
      id: 'call_sample',
      function: { name: 'read', arguments: '{"path":"sample.txt"}' },
    },
  ]);
  expect(response.usage).toMatchObject({ total_tokens: 125 });
  expect(fetch).toHaveBeenCalledTimes(2);
});
