import pino from 'pino';

import { describe, expect, test, vi } from 'vitest';

import mediaTools from '../plugins/media-tools/src/index.js';
import type {
  PluginPromptHook,
  PluginToolDefinition,
} from '../src/plugins/plugin-types.js';

interface Readiness {
  tool: string;
  status: 'configured' | 'unavailable' | 'unknown';
  providers: string[];
  reason?: string;
}

function setup() {
  const tools: PluginToolDefinition[] = [];
  const hooks: PluginPromptHook[] = [];
  const secrets: Record<string, string> = {};
  const model = {
    provider: 'hybridai',
    model: 'test-model',
    apiKey: '',
    baseUrl: '',
  };
  const api = {
    config: {},
    logger: pino({ enabled: false }),
    getCredential: (name: string) => secrets[name],
    getSessionInfo: vi.fn(() => ({ workspaceRoot: '/unused' })),
    media: {
      getSessionModelCredentials: vi.fn(async () => ({ ...model })),
      resolveInputPath: vi.fn(),
      fetchRemote: vi.fn(),
      workspaceDisplayRoot: '/workspace',
    },
    registerTool: (tool: PluginToolDefinition) => tools.push(tool),
    registerPromptHook: (hook: PluginPromptHook) => hooks.push(hook),
  };
  mediaTools.register(api);
  const context = {
    sessionId: 'test-session',
    userId: 'test-user',
    agentId: 'test-agent',
    channelId: 'web',
    recentMessages: [],
    extraContext: [],
  };
  async function render() {
    expect(hooks).toHaveLength(1);
    const text = await hooks[0].render(context);
    expect(text).toBeTypeOf('string');
    const entries = JSON.parse(
      String(text).split('\n').at(-1) ?? '',
    ) as Readiness[];
    expect(entries.map(({ tool }) => tool)).toEqual(
      tools.map(({ name }) => name),
    );
    return { text: String(text), entries };
  }
  return { api, tools, secrets, model, render };
}

describe('media capability readiness', () => {
  test('reports unavailable providers before execution without inspecting media', async () => {
    const { api, render } = setup();
    const { entries } = await render();
    expect(
      entries.every(
        ({ status, providers, reason }) =>
          status === 'unavailable' && providers.length === 0 && Boolean(reason),
      ),
    ).toBe(true);
    expect(
      api.media.getSessionModelCredentials,
    ).toHaveBeenCalledExactlyOnceWith('test-session');
    expect(api.getSessionInfo).not.toHaveBeenCalled();
    expect(api.media.resolveInputPath).not.toHaveBeenCalled();
    expect(api.media.fetchRemote).not.toHaveBeenCalled();
  });

  test.each([
    ['OPENAI_API_KEY', 'openai'],
    ['GOOGLE_API_KEY', 'gemini'],
    ['XAI_API_KEY', 'xai'],
    ['BLACK_FOREST_LABS_API_KEY', 'bfl'],
    ['DEEPGRAM_API_KEY', 'deepgram'],
    ['ASSEMBLYAI_API_KEY', 'assemblyai'],
  ])(
    'uses the execution provider selection for %s without exposing credentials',
    async (key, provider) => {
      const { api, secrets, tools, render } = setup();
      secrets[key] = 'test-secret-canary';
      const { text, entries } = await render();
      expect(text).not.toContain(secrets[key]);
      expect(entries.some((entry) => entry.providers.includes(provider))).toBe(
        true,
      );
      for (const [index, tool] of tools.entries()) {
        const output = await tool.handler(
          { action: 'list' },
          {
            sessionId: 'test-session',
            channelId: 'web',
            pluginId: 'media-tools',
            logger: api.logger,
            media: [],
          },
        );
        const list = JSON.parse(String(output)) as {
          providers: { id: string; ready: boolean }[];
        };
        const ready = list.providers
          .filter((entry) => entry.ready)
          .map(({ id }) => id);
        expect(entries[index].providers).toEqual(ready);
        expect(entries[index].status).toBe(
          ready.length ? 'configured' : 'unavailable',
        );
      }
    },
  );

  test('refreshes credentials each turn without changing schemas or earlier snapshots', async () => {
    const { tools, secrets, render } = setup();
    const definitions = JSON.stringify(tools);
    const before = await render();
    secrets.DEEPGRAM_API_KEY = 'test-key';
    const configured = await render();
    delete secrets.DEEPGRAM_API_KEY;
    const after = await render();
    expect(
      configured.entries.find(({ tool }) => tool === 'audio_transcribe'),
    ).toMatchObject({
      status: 'configured',
      providers: ['deepgram'],
    });
    expect(after).toEqual(before);
    expect(JSON.stringify(tools)).toBe(definitions);
  });

  test('includes session credentials and never serializes their values or endpoint', async () => {
    const { model, render } = setup();
    Object.assign(model, {
      provider: 'openai-codex',
      apiKey: 'test-session-secret',
      baseUrl: 'https://private.example/api',
    });
    const { text, entries } = await render();
    expect(
      entries.every(
        ({ status, providers }) =>
          status === 'configured' && providers.includes('openai'),
      ),
    ).toBe(true);
    expect(text).not.toContain(model.apiKey);
    expect(text).not.toContain(model.baseUrl);
  });

  test('reports unknown when session readiness cannot be checked, while keeping dedicated providers usable', async () => {
    const { api, secrets, render } = setup();
    api.media.getSessionModelCredentials.mockRejectedValue(
      new Error('test-private-error'),
    );
    const before = await render();
    expect(before.entries.every(({ status }) => status === 'unknown')).toBe(
      true,
    );
    expect(before.text).not.toContain('test-private-error');
    secrets.DEEPGRAM_API_KEY = 'test-key';
    const after = await render();
    expect(
      after.entries.find(({ tool }) => tool === 'audio_transcribe'),
    ).toMatchObject({
      status: 'configured',
      providers: ['deepgram'],
    });
    expect(
      after.entries
        .filter(({ tool }) => tool !== 'audio_transcribe')
        .every(({ status }) => status === 'unknown'),
    ).toBe(true);
  });
});
