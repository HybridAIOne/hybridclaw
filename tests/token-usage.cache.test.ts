import { describe, expect, test } from 'vitest';

import {
  accumulateApiUsage,
  createTokenUsageStats,
} from '../container/src/token-usage.js';
import type { ChatCompletionResponse } from '../container/src/types.js';

function buildResponse(usage: Record<string, unknown>): ChatCompletionResponse {
  return {
    id: 'resp_1',
    model: 'gpt-5-nano',
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'ok',
        },
        finish_reason: 'stop',
      },
    ],
    usage: usage as ChatCompletionResponse['usage'],
  };
}

describe('accumulateApiUsage cache normalization', () => {
  test('parses cache_read_input_tokens and cache_creation_input_tokens', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
      }),
    );

    expect(stats.apiUsageAvailable).toBe(true);
    expect(stats.apiCacheUsageAvailable).toBe(true);
    expect(stats.apiCacheReadTokens).toBe(900);
    expect(stats.apiCacheWriteTokens).toBe(100);
  });

  test('parses cache_read and cache_write naming variants', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        prompt_tokens: 1000,
        completion_tokens: 50,
        cache_read: 1500,
        cache_write: 200,
      }),
    );

    expect(stats.apiCacheUsageAvailable).toBe(true);
    expect(stats.apiCacheReadTokens).toBe(1500);
    expect(stats.apiCacheWriteTokens).toBe(200);
  });

  test('parses Moonshot/Kimi cached_tokens field', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        prompt_tokens: 30,
        completion_tokens: 9,
        total_tokens: 39,
        cached_tokens: 19,
      }),
    );

    expect(stats.apiCacheUsageAvailable).toBe(true);
    expect(stats.apiCacheReadTokens).toBe(19);
    expect(stats.apiCacheWriteTokens).toBe(0);
  });

  test('parses prompt_tokens_details.cached_tokens', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        prompt_tokens: 1113,
        completion_tokens: 5,
        total_tokens: 1118,
        prompt_tokens_details: { cached_tokens: 1024 },
      }),
    );

    expect(stats.apiCacheUsageAvailable).toBe(true);
    expect(stats.apiCacheReadTokens).toBe(1024);
    expect(stats.apiCacheWriteTokens).toBe(0);
  });

  test('keeps cache usage when provider reports only cache fields', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        cached_tokens: 2048,
      }),
    );

    expect(stats.apiUsageAvailable).toBe(false);
    expect(stats.apiCacheUsageAvailable).toBe(true);
    expect(stats.apiCacheReadTokens).toBe(2048);
    expect(stats.apiCacheWriteTokens).toBe(0);
  });

  test('does not mark cache usage as available without cache fields', () => {
    const stats = createTokenUsageStats();
    accumulateApiUsage(
      stats,
      buildResponse({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      }),
    );

    expect(stats.apiUsageAvailable).toBe(true);
    expect(stats.apiCacheUsageAvailable).toBe(false);
    expect(stats.apiCacheReadTokens).toBe(0);
    expect(stats.apiCacheWriteTokens).toBe(0);
  });
});
