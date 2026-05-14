import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('probeHybridAI returns unreachable when bot fetch fails', async () => {
  const fetchHybridAIBots = vi.fn(async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:5000');
  });
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIAuthStatus: vi.fn(() => ({
      authenticated: true,
      apiKeyConfigured: true,
      apiKeySource: 'env',
    })),
  }));
  vi.doMock('../src/providers/hybridai-bots.js', () => ({
    fetchHybridAIBots,
  }));

  const { probeHybridAI } = await import('../src/doctor/provider-probes.js');

  await expect(probeHybridAI()).resolves.toEqual({
    reachable: false,
    detail: 'connect ECONNREFUSED 127.0.0.1:5000',
  });
  expect(fetchHybridAIBots).toHaveBeenCalledWith({ cacheTtlMs: 0 });
});

test('probeHybridAI stringifies non-Error bot fetch failures', async () => {
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIAuthStatus: vi.fn(() => ({
      authenticated: true,
      apiKeyConfigured: true,
      apiKeySource: 'env',
    })),
  }));
  vi.doMock('../src/providers/hybridai-bots.js', () => ({
    fetchHybridAIBots: vi.fn(async () => {
      throw 'temporary outage';
    }),
  }));

  const { probeHybridAI } = await import('../src/doctor/provider-probes.js');

  await expect(probeHybridAI()).resolves.toEqual({
    reachable: false,
    detail: 'temporary outage',
  });
});
