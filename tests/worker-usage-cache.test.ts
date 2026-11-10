import { expect, test } from 'vitest';
import type { TokenUsageStats } from '@hybridclaw/shared/token-usage';
import { createTokenUsageStats } from '@hybridclaw/shared/token-usage';
import { readCacheTokenUsage } from '../src/usage/token-usage-buffer.js';

test('primary cache pricing excludes helper cache counters', () => {
  const primary = {
    ...createTokenUsageStats(),
    modelCalls: 1,
    apiCacheUsageAvailable: true,
    apiCacheReadTokens: 40,
    apiCacheWriteTokens: 10,
  };
  const helper = {
    ...primary,
    apiCacheReadTokens: 80,
    apiCacheWriteTokens: 20,
  };
  const usage: TokenUsageStats = {
    ...primary,
    modelCalls: 2,
    apiCacheReadTokens: 120,
    apiCacheWriteTokens: 30,
    modelUsage: [
      {
        model: 'openrouter/example/primary',
        status: 'success',
        durationMs: 1,
        usage: primary,
      },
      {
        model: 'openrouter/example/helper',
        task: 'vision',
        status: 'success',
        durationMs: 1,
        usage: helper,
      },
    ],
  };
  expect(readCacheTokenUsage(usage)).toEqual({
    cacheReadTokens: 40,
    cacheWriteTokens: 10,
  });
  expect(readCacheTokenUsage(helper)).toEqual({
    cacheReadTokens: 80,
    cacheWriteTokens: 20,
  });
});
