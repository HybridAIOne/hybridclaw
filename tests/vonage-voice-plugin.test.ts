import { expect, test, vi } from 'vitest';
import type {
  HybridClawPluginApi,
  PluginCommandDefinition,
  PluginInboundWebhookDefinition,
  PluginService,
  PluginWebsocketWebhookDefinition,
} from '../src/plugins/plugin-sdk.js';

function createApi(overrides: Record<string, unknown> = {}) {
  const webhooks: PluginInboundWebhookDefinition[] = [];
  const websocketWebhooks: PluginWebsocketWebhookDefinition[] = [];
  const commands: PluginCommandDefinition[] = [];
  const services: PluginService[] = [];
  const api = {
    config: { agents: { defaultAgentId: 'main' } },
    pluginConfig: {
      applicationId: 'app-id',
      fromNumber: '+14155550123',
      publicBaseUrl: 'https://voice.example.com',
    },
    getCredential: (key: string) =>
      key === 'VONAGE_PRIVATE_KEY' ? 'test-key' : 'test-secret',
    registerInboundWebhook: (webhook: PluginInboundWebhookDefinition) =>
      webhooks.push(webhook),
    registerWebsocketWebhook: (webhook: PluginWebsocketWebhookDefinition) =>
      websocketWebhooks.push(webhook),
    registerCommand: (command: PluginCommandDefinition) =>
      commands.push(command),
    registerService: (service: PluginService) => services.push(service),
    dispatchInboundMessage: vi.fn(),
    isRealtimeVoiceAvailable: () => true,
    createRealtimeVoiceSession: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as unknown as HybridClawPluginApi;
  return { api, webhooks, websocketWebhooks, commands, services };
}

test('registers isolated Vonage webhooks, command, and runtime service', async () => {
  const { api, webhooks, websocketWebhooks, commands, services } = createApi();
  const plugin = (await import('../plugins/vonage-voice/src/index.js')).default;

  plugin.register(api);

  expect(webhooks.map((webhook) => webhook.name)).toEqual([
    'answer',
    'event',
    'input',
  ]);
  expect(websocketWebhooks).toHaveLength(0);
  expect(webhooks.every((webhook) => webhook.method === 'POST')).toBe(true);
  expect(commands.map((command) => command.name)).toEqual(['vonage']);
  expect(services.map((service) => service.id)).toEqual([
    'vonage-voice-runtime',
  ]);
  await expect(commands[0]?.handler(['info'], {} as never)).resolves.toContain(
    '/api/plugin-webhooks/vonage-voice/answer',
  );
});

test('realtime mode swaps the input webhook for a stream websocket', async () => {
  const { api, webhooks, websocketWebhooks, commands } = createApi({
    pluginConfig: {
      applicationId: 'app-id',
      fromNumber: '+14155550123',
      publicBaseUrl: 'https://voice.example.com',
      mode: 'realtime',
    },
  });
  const plugin = (await import('../plugins/vonage-voice/src/index.js')).default;

  plugin.register(api);

  expect(webhooks.map((webhook) => webhook.name)).toEqual(['answer', 'event']);
  expect(websocketWebhooks.map((webhook) => webhook.name)).toEqual(['stream']);
  await expect(commands[0]?.handler(['info'], {} as never)).resolves.toContain(
    'realtime speech-to-speech',
  );
});

test('fails fast when a required Vonage credential is missing', async () => {
  const { api } = createApi({ getCredential: () => undefined });
  const plugin = (await import('../plugins/vonage-voice/src/index.js')).default;

  expect(() => plugin.register(api)).toThrow('VONAGE_PRIVATE_KEY is required');
});

test('removes trailing slashes from the public webhook URL', async () => {
  const trailingSlashes = '/'.repeat(10_000);
  const { api } = createApi({
    pluginConfig: {
      applicationId: 'app-id',
      fromNumber: '+14155550123',
      publicBaseUrl: `https://voice.example.com${trailingSlashes}`,
    },
  });
  const { resolveConfig } = await import(
    '../plugins/vonage-voice/src/config.js'
  );

  expect(resolveConfig(api).publicBaseUrl).toBe('https://voice.example.com');
});
