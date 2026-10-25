import { expect, test, vi } from 'vitest';

import plugin from '../plugins/hybridai-knowledge/src/index.js';
import { runMaintenance } from '../plugins/hybridai-knowledge/src/maintenance.js';
import type {
  MemoryLayerPlugin,
  PluginService,
} from '../src/plugins/plugin-types.js';
import type { McpServerConfig } from '../src/types/models.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({
  restoreAllMocks: true,
  unstubAllGlobals: true,
  cleanup: () => {
    vi.useRealTimers();
  },
});

test.each(['error', 'timeout'])(
  'retrieval %s skips subsequent calls until the cooldown expires',
  async (failure) => {
    const { layer, fetchMock } = setup();
    if (failure === 'timeout') {
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('timeout')), ms);
        return controller.signal;
      });
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('Expected a timeout signal');
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );
    } else {
      fetchMock.mockRejectedValueOnce(new Error('connection refused'));
    }
    const pending = layer.getContextForPrompt!(request);
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(await layer.getContextForPrompt!(request)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await layer.getContextForPrompt!(request);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  },
);

const DAY_MS = 24 * 60 * 60 * 1000;
const disabledServer: McpServerConfig = { enabled: false };
const request = {
  sessionId: 'session-1',
  userId: 'user-1',
  agentId: 'main',
  recentMessages: [
    {
      id: 1,
      session_id: 'session-1',
      user_id: 'user-1',
      username: null,
      role: 'user' as const,
      content: 'Example question',
      created_at: '2026-10-25T02:59:00Z',
    },
  ],
};

function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-25T02:59:00Z'));
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Response.json({ result: { content: [] } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const api = {
    config: { hybridai: { baseUrl: 'https://example.com' } },
    pluginConfig: { maintenance: { enabled: true, hourUtc: 3 } },
    getCredential: vi.fn<() => string | undefined>(() => 'test-key'),
    getMcpServerConfig: vi.fn<() => McpServerConfig | null>(() => null),
    registerMemoryLayer: vi.fn<(layer: MemoryLayerPlugin) => void>(),
    registerService: vi.fn<(service: PluginService) => void>(),
    getDefaultAgentId: () => 'main',
    dispatchInboundMessage: vi.fn(async () => ({ result: 'Done' })),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  plugin.register(api);
  const layer = api.registerMemoryLayer.mock.calls[0][0];
  const service = api.registerService.mock.calls[0][0];
  return { api, layer, service, fetchMock };
}

test.each([
  ['missing key', undefined, null],
  ['empty key', '', null],
  ['blank key', ' \t ', null],
  ['disabled connection with a key', 'test-key', disabledServer],
] as const)(
  '%s skips retrieval and daily maintenance',
  async (_name, key, server) => {
    const { api, layer, service, fetchMock } = setup();
    api.getCredential.mockReturnValue(key);
    api.getMcpServerConfig.mockReturnValue(server);

    expect(await layer.getContextForPrompt!(request)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await service.start!();
    try {
      await vi.advanceTimersByTimeAsync(60_000 + DAY_MS);
      expect(api.dispatchInboundMessage).not.toHaveBeenCalled();
      expect(await runMaintenance({ api, config: api.pluginConfig })).toBe('');
      expect(api.dispatchInboundMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await service.stop!();
    }
  },
);

test.each([null, { enabled: true }])(
  'a valid key permits retrieval and maintenance with MCP config %j',
  async (server) => {
    const { api, layer, service, fetchMock } = setup();
    api.getMcpServerConfig.mockReturnValue(server);
    await layer.getContextForPrompt!(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(api.getMcpServerConfig).toHaveBeenCalledWith('hybridai');
    await service.start!();
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    } finally {
      await service.stop!();
    }
  },
);

test.each(['remove key', 'disable connection'])(
  '%s after startup blocks work until restored',
  async (change) => {
    const { api, layer, service, fetchMock } = setup();
    await service.start!();
    try {
      await layer.getContextForPrompt!(request);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(api.dispatchInboundMessage).toHaveBeenCalledTimes(1);

      if (change === 'remove key') api.getCredential.mockReturnValue(undefined);
      else api.getMcpServerConfig.mockReturnValue(disabledServer);
      expect(await layer.getContextForPrompt!(request)).toBeNull();
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(api.dispatchInboundMessage).toHaveBeenCalledTimes(1);

      api.getCredential.mockReturnValue('test-key');
      api.getMcpServerConfig.mockReturnValue(null);
      await layer.getContextForPrompt!(request);
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(api.dispatchInboundMessage).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop!();
    }
  },
);
