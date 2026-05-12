import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

test('setWebSearchConfig warns before clearing runtime-only provider keys', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { setWebSearchConfig } = await import('../container/src/tools.js');

  setWebSearchConfig({
    provider: 'auto',
    fallbackProviders: [],
    defaultCount: 5,
    cacheTtlMinutes: 5,
    searxngBaseUrl: '',
    tavilySearchDepth: 'advanced',
    braveApiKey: 'brave-secret',
  });
  setWebSearchConfig(undefined);

  expect(warn).toHaveBeenCalledWith(
    '[web-search] runtime config cleared; provider API keys supplied through runtime config will be unavailable until a new config arrives.',
  );
});
