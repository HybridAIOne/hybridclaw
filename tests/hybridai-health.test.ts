import { afterEach, describe, expect, test, vi } from 'vitest';

const probeHybridAIMock = vi.fn();

vi.mock('../src/doctor/provider-probes.js', () => ({
  probeHybridAI: probeHybridAIMock,
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.resetModules();
});

async function importFreshModule() {
  probeHybridAIMock.mockReset();
  vi.resetModules();

  vi.doMock('../src/doctor/provider-probes.js', () => ({
    probeHybridAI: probeHybridAIMock,
  }));
  vi.doMock('../src/logger.js', () => ({
    logger: { warn: vi.fn() },
  }));

  return import('../src/providers/hybridai-health.js');
}

describe('hybridai-health', () => {
  test('peek() returns null before any probe', async () => {
    const mod = await importFreshModule();
    expect(mod.hybridAIProbe.peek()).toBeNull();
  });

  test('get() probes and returns a successful result', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockResolvedValueOnce({
      reachable: true,
      detail: '42ms',
      modelCount: 5,
    });

    const result = await mod.hybridAIProbe.get();
    expect(result).toMatchObject({
      reachable: true,
      modelCount: 5,
    });
    expect(typeof result.latencyMs).toBe('number');
    expect(result.error).toBeUndefined();
  });

  test('get() returns unreachable result when probe returns reachable=false', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockResolvedValueOnce({
      reachable: false,
      detail: 'API key missing',
    });

    const result = await mod.hybridAIProbe.get();
    expect(result.reachable).toBe(false);
  });

  test('get() returns error result when probe throws', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await mod.hybridAIProbe.get();
    expect(result).toMatchObject({
      reachable: false,
      error: 'connect ECONNREFUSED',
    });
    expect(typeof result.latencyMs).toBe('number');
  });

  test('get() caches result within TTL', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockResolvedValueOnce({
      reachable: true,
      detail: '10ms',
      modelCount: 3,
    });

    await mod.hybridAIProbe.get();
    await mod.hybridAIProbe.get();

    expect(probeHybridAIMock).toHaveBeenCalledTimes(1);
  });

  test('peek() returns cached value after get()', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockResolvedValueOnce({
      reachable: true,
      detail: '5ms',
      modelCount: 1,
    });

    await mod.hybridAIProbe.get();
    const peeked = mod.hybridAIProbe.peek();
    expect(peeked).toMatchObject({ reachable: true, modelCount: 1 });
  });

  test('non-Error throw is stringified in error result', async () => {
    const mod = await importFreshModule();

    probeHybridAIMock.mockRejectedValueOnce('string error');

    const result = await mod.hybridAIProbe.get();
    expect(result).toMatchObject({
      reachable: false,
      error: 'string error',
    });
  });
});
