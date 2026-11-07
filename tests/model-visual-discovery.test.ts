import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({
  resetModules: true,
  unstubAllGlobals: true,
  unmock: [
    '../src/config/config.js',
    '../src/providers/openai-compat-remote.js',
  ],
});

test.each([
  { metadata: { input_modalities: ['text'] }, accepts: false },
  { metadata: { input_modalities: ['text', 'image'] }, accepts: true },
  { metadata: {}, accepts: true },
])('waits for cold discovery and reuses its result: %j', async ({ metadata, accepts }) => {
  vi.doMock('../src/config/config.js', async (original) => ({
    ...(await original<typeof import('../src/config/config.js')>()),
    OPENROUTER_BASE_URL: 'https://example.com/v1',
    OPENROUTER_ENABLED: true,
  }));
  vi.doMock('../src/providers/openai-compat-remote.js', async (original) => ({
    ...(await original<typeof import('../src/providers/openai-compat-remote.js')>()),
    readApiKeyForOpenAICompatProvider: () => 'test-key',
  }));
  let finishDiscovery!: (response: Response) => void;
  const discovery = new Promise<Response>((resolve) => {
    finishDiscovery = resolve;
  });
  const fetch = vi.fn(() => discovery);
  vi.stubGlobal('fetch', fetch);
  const { canModelAcceptVisualMedia } = await import('../src/providers/model-catalog.js');
  const { getDiscoveredOpenRouterModelVisionCapability } = await import('../src/providers/openrouter-discovery.js');
  expect(getDiscoveredOpenRouterModelVisionCapability('openrouter/example/model')).toBeNull();
  const settled = vi.fn();
  const pending = canModelAcceptVisualMedia('openrouter/example/model').then(settled);
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledOnce();
  expect(settled).not.toHaveBeenCalled();
  finishDiscovery(new Response(JSON.stringify({
    data: [{ id: 'example/model', architecture: metadata }],
  })));
  await pending;
  expect(settled).toHaveBeenCalledWith(accepts);
  await expect(canModelAcceptVisualMedia('openrouter/example/model')).resolves.toBe(accepts);
  expect(fetch).toHaveBeenCalledOnce();
});
