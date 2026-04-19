import { afterEach, describe, expect, test, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';

const ORIGINAL_TEST_API_KEYS = process.env.TEST_API_KEYS;
const ORIGINAL_TEST_API_KEY_1 = process.env.TEST_API_KEY_1;
const ORIGINAL_TEST_API_KEY_2 = process.env.TEST_API_KEY_2;

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
  vi.doMock('../src/security/runtime-secrets.js', () => ({
    readStoredRuntimeSecrets: () => ({}),
    runtimeSecretsPath: () =>
      path.join(os.tmpdir(), 'hybridclaw-test-runtime-secrets.json'),
  }));
  const utils = await import('../src/providers/provider-api-key-utils.ts');
  return { ...utils, refreshRuntimeSecretsFromEnv, MissingRequiredEnvVarError };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('../src/config/config.js');
  vi.doUnmock('../src/security/runtime-secrets.js');
  vi.resetModules();
  if (ORIGINAL_TEST_API_KEYS === undefined) {
    delete process.env.TEST_API_KEYS;
  } else {
    process.env.TEST_API_KEYS = ORIGINAL_TEST_API_KEYS;
  }
  if (ORIGINAL_TEST_API_KEY_1 === undefined) {
    delete process.env.TEST_API_KEY_1;
  } else {
    process.env.TEST_API_KEY_1 = ORIGINAL_TEST_API_KEY_1;
  }
  if (ORIGINAL_TEST_API_KEY_2 === undefined) {
    delete process.env.TEST_API_KEY_2;
  } else {
    process.env.TEST_API_KEY_2 = ORIGINAL_TEST_API_KEY_2;
  }
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

  test('falls back to pooled provider keys when no direct key is present', async () => {
    process.env.TEST_API_KEYS = ' pooled-one , pooled-two ';
    process.env.TEST_API_KEY_1 = 'indexed-one';
    process.env.TEST_API_KEY_2 = 'indexed-two';
    const { readProviderApiKey } = await importFreshUtils();

    expect(
      readProviderApiKey(() => [''], 'TEST_API_KEY', {
        required: false,
      }),
    ).toBe('pooled-one');
  });
});
