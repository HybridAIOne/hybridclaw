import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  });
}

function makeKeychainPayload(token: string, expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:child_process');
  setPlatform(ORIGINAL_PLATFORM);
});

test('requireAnthropicClaudeCliCredential caches valid keychain credentials briefly', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  setPlatform('darwin');

  const execFileSync = vi.fn(() =>
    makeKeychainPayload('sk-ant-oat-cache-test', Date.now() + 600_000),
  );
  vi.doMock('node:child_process', () => ({
    execFileSync,
  }));

  const auth = await import('../src/auth/anthropic-auth.js');

  expect(auth.requireAnthropicClaudeCliCredential()).toMatchObject({
    type: 'oauth',
    accessToken: 'sk-ant-oat-cache-test',
    source: 'claude-cli-keychain',
  });
  expect(auth.requireAnthropicClaudeCliCredential()).toMatchObject({
    accessToken: 'sk-ant-oat-cache-test',
  });
  expect(execFileSync).toHaveBeenCalledTimes(1);
});

test('requireAnthropicClaudeCliCredential refreshes the keychain credential after cache ttl', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  setPlatform('darwin');

  const execFileSync = vi
    .fn()
    .mockImplementationOnce(() =>
      makeKeychainPayload('sk-ant-oat-cache-first', Date.now() + 600_000),
    )
    .mockImplementationOnce(() =>
      makeKeychainPayload('sk-ant-oat-cache-second', Date.now() + 600_000),
    );
  vi.doMock('node:child_process', () => ({
    execFileSync,
  }));

  const auth = await import('../src/auth/anthropic-auth.js');

  expect(auth.requireAnthropicClaudeCliCredential()).toMatchObject({
    accessToken: 'sk-ant-oat-cache-first',
  });
  vi.advanceTimersByTime(61_000);
  expect(auth.requireAnthropicClaudeCliCredential()).toMatchObject({
    accessToken: 'sk-ant-oat-cache-second',
  });
  expect(execFileSync).toHaveBeenCalledTimes(2);
});
