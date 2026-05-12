import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/providers/hybridai-discovery.js');
  vi.doUnmock('../src/providers/hybridai-health.js');
  vi.doUnmock('../src/providers/local-health.js');
  vi.resetModules();
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
});

test('resolveGatewayHybridAIHealth uses a generic uncached fallback', async () => {
  process.env.HYBRIDAI_API_KEY = 'hai-test-gateway-health';
  const get = vi.fn(async () => ({
    reachable: true,
    latencyMs: 10,
  }));
  vi.doMock('../src/providers/hybridai-discovery.js', () => ({
    getDiscoveredHybridAIModelNames: vi.fn(() => []),
  }));
  vi.doMock('../src/providers/hybridai-health.js', () => ({
    hybridAIProbe: {
      get,
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
  }));

  const { resolveGatewayHybridAIHealth } = await import(
    '../src/gateway/gateway-health-service.js'
  );

  await expect(
    resolveGatewayHybridAIHealth({ refreshProviderHealth: false }),
  ).resolves.toEqual({
    reachable: false,
    error: 'unavailable',
    latencyMs: 0,
  });
  expect(get).not.toHaveBeenCalled();
});
