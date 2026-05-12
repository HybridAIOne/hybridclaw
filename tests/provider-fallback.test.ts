import { performance } from 'node:perf_hooks';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ResolvedModelRuntimeCredentials } from '../src/providers/types.js';

const resolveModelRuntimeCredentials = vi.fn();

vi.mock('../src/providers/factory.js', () => ({
  resolveModelRuntimeCredentials: (
    params: { model: string; chatbotId?: string; agentId?: string } | undefined,
  ) => resolveModelRuntimeCredentials(params),
}));

async function importModule() {
  return import('../src/gateway/provider-fallback.js');
}

function runtimeFixture(
  provider: string,
  overrides: Partial<ResolvedModelRuntimeCredentials> = {},
): ResolvedModelRuntimeCredentials {
  return {
    provider: provider as ResolvedModelRuntimeCredentials['provider'],
    apiKey: `${provider}-key`,
    baseUrl: `https://${provider}.example.com/v1`,
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    ...overrides,
  };
}

beforeEach(() => {
  resolveModelRuntimeCredentials.mockReset();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadFallbackChainFromEnv', () => {
  test('returns empty list for missing or invalid values', async () => {
    const mod = await importModule();
    expect(mod.loadFallbackChainFromEnv(undefined)).toEqual([]);
    expect(mod.loadFallbackChainFromEnv('')).toEqual([]);
    expect(mod.loadFallbackChainFromEnv('not json')).toEqual([]);
    expect(mod.loadFallbackChainFromEnv('{}')).toEqual([]);
  });

  test('parses well-formed entries and drops invalid ones', async () => {
    const mod = await importModule();
    const chain = mod.loadFallbackChainFromEnv(
      JSON.stringify([
        { model: 'gpt-4o-mini' },
        { model: '   ' },
        { baseUrl: 'https://x' },
        {
          model: 'claude-3-5-haiku',
          baseUrl: 'https://anthropic.example/v1',
          keyEnv: 'ANTHROPIC_KEY',
          chatbotId: 'cb-2',
        },
      ]),
    );
    expect(chain).toEqual([
      { model: 'gpt-4o-mini' },
      {
        model: 'claude-3-5-haiku',
        baseUrl: 'https://anthropic.example/v1',
        keyEnv: 'ANTHROPIC_KEY',
        chatbotId: 'cb-2',
      },
    ]);
  });
});

describe('classifyProviderError', () => {
  test('identifies auth, rate-limit, and unknown failures', async () => {
    const mod = await importModule();
    expect(mod.classifyProviderError(new Error('failed with 401: bad'))).toBe(
      'auth',
    );
    expect(mod.classifyProviderError(new Error('Forbidden: blocked'))).toBe(
      'auth',
    );
    expect(mod.classifyProviderError(new Error('HTTP 429 too many'))).toBe(
      'rate_limit',
    );
    expect(mod.classifyProviderError(new Error('daily quota exhausted'))).toBe(
      'rate_limit',
    );
    expect(mod.classifyProviderError(new Error('500 internal'))).toBe('other');
  });
});

describe('ProviderFallbackController', () => {
  test('advances through chain and skips unresolvable entries', async () => {
    const mod = await importModule();
    resolveModelRuntimeCredentials
      .mockResolvedValueOnce(runtimeFixture('openrouter'))
      .mockRejectedValueOnce(new Error('no credentials'))
      .mockResolvedValueOnce(runtimeFixture('mistral'));

    const controller = new mod.ProviderFallbackController({
      chain: [
        { model: 'openrouter/a' },
        { model: 'broken/b' },
        { model: 'mistral/c' },
      ],
      primaryProvider: 'openai',
    });

    const first = await controller.tryActivate('auth', 'openai');
    expect(first?.runtime.provider).toBe('openrouter');
    expect(controller.isActivated()).toBe(true);

    const second = await controller.tryActivate('auth', 'openrouter');
    expect(second?.runtime.provider).toBe('mistral');

    const third = await controller.tryActivate('auth', 'mistral');
    expect(third).toBeNull();
    expect(controller.hasRemaining()).toBe(false);
  });

  test('rate-limit cooldown only set when leaving primary', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();

    resolveModelRuntimeCredentials
      .mockResolvedValueOnce(runtimeFixture('openrouter'))
      .mockResolvedValueOnce(runtimeFixture('mistral'));

    const controller = new mod.ProviderFallbackController({
      chain: [{ model: 'openrouter/a' }, { model: 'mistral/b' }],
      primaryProvider: 'openai',
      cooldownMs: 500,
    });

    await controller.tryActivate('rate_limit', 'openai');
    expect(mod.isProviderCooledDown('openai')).toBe(true);

    mod.clearProviderCooldown('openai');

    await controller.tryActivate('rate_limit', 'openrouter');
    expect(mod.isProviderCooledDown('openai')).toBe(false);
  });

  test('keyEnv override wins over provider credentials', async () => {
    const mod = await importModule();
    resolveModelRuntimeCredentials.mockResolvedValueOnce(
      runtimeFixture('openrouter', { apiKey: 'fallback-key' }),
    );
    vi.stubEnv('CUSTOM_KEY_ENV', 'env-override');

    const controller = new mod.ProviderFallbackController({
      chain: [{ model: 'openrouter/a', keyEnv: 'CUSTOM_KEY_ENV' }],
      primaryProvider: 'openai',
    });

    const activation = await controller.tryActivate('auth', 'openai');
    expect(activation?.runtime.apiKey).toBe('env-override');
    vi.unstubAllEnvs();
  });
});

describe('callWithProviderFallback', () => {
  test('invokes primary only when chain is empty', async () => {
    const mod = await importModule();
    const invoke = vi.fn().mockResolvedValue({ id: 'ok' });
    const result = await mod.callWithProviderFallback({
      primaryRuntime: runtimeFixture('openai'),
      primaryModel: 'gpt-4o',
      chain: [],
      invoke,
    });
    expect(result).toEqual({ id: 'ok' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('falls back on auth error and returns fallback result', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    resolveModelRuntimeCredentials.mockResolvedValueOnce(
      runtimeFixture('openrouter'),
    );

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider returned 401'))
      .mockResolvedValueOnce({ id: 'fallback' });

    const onFallback = vi.fn();
    const result = await mod.callWithProviderFallback({
      primaryRuntime: runtimeFixture('openai'),
      primaryModel: 'gpt-4o',
      chain: [{ model: 'openrouter/a' }],
      invoke,
      onFallback,
    });

    expect(result).toEqual({ id: 'fallback' });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]?.[0].provider).toBe('openrouter');
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ entry: { model: 'openrouter/a' } }),
      'auth',
    );
  });

  test('non-auth / non-rate-limit errors surface without fallback', async () => {
    const mod = await importModule();
    const invoke = vi.fn().mockRejectedValueOnce(new Error('500 server down'));
    await expect(
      mod.callWithProviderFallback({
        primaryRuntime: runtimeFixture('openai'),
        primaryModel: 'gpt-4o',
        chain: [{ model: 'openrouter/a' }],
        invoke,
      }),
    ).rejects.toThrow('500 server down');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('primary cooldown skips straight to fallback on next request', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    mod.markProviderCooldown('openai', 5_000);

    resolveModelRuntimeCredentials.mockResolvedValueOnce(
      runtimeFixture('openrouter'),
    );
    const invoke = vi.fn().mockResolvedValueOnce({ id: 'fallback' });

    const result = await mod.callWithProviderFallback({
      primaryRuntime: runtimeFixture('openai'),
      primaryModel: 'gpt-4o',
      chain: [{ model: 'openrouter/a' }],
      invoke,
    });

    expect(result).toEqual({ id: 'fallback' });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[0].provider).toBe('openrouter');
    mod.clearProviderCooldown();
  });

  test('cooled-down primary does not extend its own deadline on subsequent requests', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    mod.markProviderCooldown('openai', 5_000);

    const cooledUntil = (() => {
      // Snapshot the deadline by sniffing isProviderCooledDown across times.
      // We don't have a getter, so probe at now and now+4000ms.
      return {
        atStart: mod.isProviderCooledDown('openai'),
      };
    })();
    expect(cooledUntil.atStart).toBe(true);

    resolveModelRuntimeCredentials
      .mockResolvedValueOnce(runtimeFixture('openrouter'))
      .mockResolvedValueOnce(runtimeFixture('openrouter'))
      .mockResolvedValueOnce(runtimeFixture('openrouter'));

    const invoke = vi.fn().mockResolvedValue({ id: 'fb' });

    // Three back-to-back requests while primary is cooled down. Each request
    // creates a fresh controller that sees `!activated`. If we marked
    // cooldown, the deadline would be pushed forward on every call and the
    // primary would never come back.
    for (let i = 0; i < 3; i += 1) {
      await mod.callWithProviderFallback({
        primaryRuntime: runtimeFixture('openai'),
        primaryModel: 'gpt-4o',
        chain: [{ model: 'openrouter/a' }],
        cooldownMs: 5_000,
        invoke,
      });
    }

    // Far enough past the original 5 s deadline to expose any extension.
    expect(mod.isProviderCooledDown('openai', performance.now() + 6_000)).toBe(
      false,
    );
    mod.clearProviderCooldown();
  });

  test('shouldFallback=false re-throws the original error without retrying', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    resolveModelRuntimeCredentials.mockResolvedValueOnce(
      runtimeFixture('openrouter'),
    );

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream 401 from primary'));

    await expect(
      mod.callWithProviderFallback({
        primaryRuntime: runtimeFixture('openai'),
        primaryModel: 'gpt-4o',
        chain: [{ model: 'openrouter/a' }],
        invoke,
        shouldFallback: () => false,
      }),
    ).rejects.toThrow('upstream 401 from primary');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test('shouldFallback=true allows fallback to proceed', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    resolveModelRuntimeCredentials.mockResolvedValueOnce(
      runtimeFixture('openrouter'),
    );

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('upstream 401 from primary'))
      .mockResolvedValueOnce({ id: 'ok' });

    const result = await mod.callWithProviderFallback({
      primaryRuntime: runtimeFixture('openai'),
      primaryModel: 'gpt-4o',
      chain: [{ model: 'openrouter/a' }],
      invoke,
      shouldFallback: () => true,
    });
    expect(result).toEqual({ id: 'ok' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test('exhausted chain re-throws the last error', async () => {
    const mod = await importModule();
    mod.clearProviderCooldown();
    resolveModelRuntimeCredentials
      .mockResolvedValueOnce(runtimeFixture('openrouter'))
      .mockResolvedValueOnce(runtimeFixture('mistral'));

    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 401 A'))
      .mockRejectedValueOnce(new Error('HTTP 401 B'))
      .mockRejectedValueOnce(new Error('HTTP 401 C'));

    await expect(
      mod.callWithProviderFallback({
        primaryRuntime: runtimeFixture('openai'),
        primaryModel: 'gpt-4o',
        chain: [{ model: 'openrouter/a' }, { model: 'mistral/b' }],
        invoke,
      }),
    ).rejects.toThrow('HTTP 401 C');
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
