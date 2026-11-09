import { describe, expect, test } from 'vitest';

import { readProviderCacheUsage } from '../container/shared/provider-cache-usage.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
} from '../container/src/token-usage.js';
import { mapOpenAICompatibleUsageToTokenStats } from '../src/gateway/openai-compatible-model.js';

describe('provider cache counter boundary', () => {
  test.each([0, 800])('preserves a reported hit count of %i in both runtimes', (hit) => {
    const usage = {
      prompt_tokens: 1000,
      completion_tokens: 100,
      total_tokens: 1100,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: 1000 - hit,
      reasoning_tokens: 25,
    };
    const worker = createTokenUsageStats();
    accumulateApiUsage(worker, { usage });
    const gateway = mapOpenAICompatibleUsageToTokenStats(usage);
    for (const result of [worker, gateway]) {
      expect(result).toMatchObject({
        apiCacheUsageAvailable: true,
        apiCacheReadTokens: hit,
        apiCacheWriteTokens: 0,
        apiPromptTokens: 1000,
        apiCompletionTokens: 100,
        apiTotalTokens: 1100,
      });
    }
  });

  test.each([
    null, [], false, {}, { prompt_cache_miss_tokens: 1000 },
    { prompt_cache_hit_tokens: null }, { prompt_cache_hit_tokens: -1 },
    { prompt_cache_hit_tokens: Infinity }, { prompt_cache_hit_tokens: NaN },
    { prompt_cache_hit_tokens: true }, { prompt_cache_hit_tokens: '' },
    { prompt_cache_hit_tokens: '12junk' }, { prompt_cache_hit_tokens: 1.5 },
    { prompt_cache_hit_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])('keeps missing or invalid cache data unknown: %j', (usage) => {
    expect(readProviderCacheUsage(usage)).toEqual({});
  });

  test.each([
    { cacheRead: 7 }, { cache_read: 7 }, { cacheReadTokens: 7 },
    { cacheReadInputTokens: 7 }, { cache_read_tokens: 7 },
    { cache_read_input_tokens: 7 }, { cached_tokens: 7 },
    { prompt_cache_hit_tokens: ' 7 ' },
    { prompt_tokens_details: { cached_tokens: 7 } },
    { input_tokens_details: { cached_tokens: 7 } },
  ])('normalizes read aliases without inventing writes: %j', (usage) => {
    expect(readProviderCacheUsage(usage)).toEqual({ cacheReadTokens: 7 });
  });

  test.each([
    { cacheWrite: 7 }, { cache_write: 7 }, { cacheWriteTokens: 7 },
    { cacheWriteInputTokens: 7 }, { cache_write_tokens: 7 },
    { cache_write_input_tokens: 7 }, { cache_creation_input_tokens: 7 },
    { prompt_tokens_details: { cache_write_tokens: 7 } },
    { input_tokens_details: { cache_write_tokens: 7 } },
  ])('normalizes write aliases without inventing reads: %j', (usage) => {
    expect(readProviderCacheUsage(usage)).toEqual({ cacheWriteTokens: 7 });
  });

  test('preserves zero precedence and never sums duplicate aliases', () => {
    expect(readProviderCacheUsage({
      cacheReadTokens: 0,
      prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
      prompt_cache_hit_tokens: 100,
      cache_creation_input_tokens: 200,
    })).toEqual({ cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  test('skips invalid aliases and malformed nested details', () => {
    expect(readProviderCacheUsage({
      cacheReadTokens: 'invalid',
      prompt_tokens_details: [],
      input_tokens_details: { cached_tokens: 0 },
      prompt_cache_hit_tokens: 100,
    })).toEqual({ cacheReadTokens: 0 });
  });
});
