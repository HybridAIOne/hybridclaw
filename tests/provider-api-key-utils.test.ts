import { afterEach, describe, expect, test, vi } from 'vitest';

async function importFreshUtils() {
  vi.resetModules();
  const refreshRuntimeSecretsFromEnv = vi.fn();
  class MissingRequiredEnvVarError extends Error {
    envVar: string;

    constructor(envVar: string) {
      super(`Missing required env var: ${envVar}`);
      this.envVar = envVar;
    }
  }
  vi.doMock('../src/config/config.js', () => ({
    refreshRuntimeSecretsFromEnv,
    MissingRequiredEnvVarError,
  }));
  const utils = await import('../src/providers/provider-api-key-utils.ts');
  return { ...utils, refreshRuntimeSecretsFromEnv, MissingRequiredEnvVarError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.resetModules();
});

describe('readProviderApiKey', () => {
  test('debounces runtime secret refreshes across repeated reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T00:00:00.000Z'));
    const { readProviderApiKey, refreshRuntimeSecretsFromEnv } =
      await importFreshUtils();

    expect(
      readProviderApiKey(() => [' test-key '], 'TEST_API_KEY', {
        required: false,
      }),
    ).toBe('test-key');
    expect(
      readProviderApiKey(() => [' test-key '], 'TEST_API_KEY', {
        required: false,
      }),
    ).toBe('test-key');
    expect(refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-28T00:00:00.249Z'));
    expect(
      readProviderApiKey(() => [' test-key '], 'TEST_API_KEY', {
        required: false,
      }),
    ).toBe('test-key');
    expect(refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-03-28T00:00:00.250Z'));
    expect(
      readProviderApiKey(() => [' test-key '], 'TEST_API_KEY', {
        required: false,
      }),
    ).toBe('test-key');
    expect(refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(2);
  });

  test('throws the provider-specific missing env error when required', async () => {
    const { readProviderApiKey, MissingRequiredEnvVarError } =
      await importFreshUtils();

    expect(() => readProviderApiKey(() => [''], 'TEST_API_KEY')).toThrow(
      MissingRequiredEnvVarError,
    );
  });
});
