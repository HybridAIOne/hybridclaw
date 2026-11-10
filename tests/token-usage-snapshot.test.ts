import { expect, test } from 'vitest';
import {
  createTokenUsageStats,
  validateTokenUsage,
} from '@hybridclaw/shared/token-usage';
import { isContainerOutput } from '../src/infra/ipc-output-validation.js';

const sample = {
  promptTokens: 20,
  completionTokens: 2,
  totalTokens: 22,
  durationMs: 10,
};
const output = { status: 'error', result: null, toolsUsed: [] };

test('normalizes available totals and copies cache and performance evidence', () => {
  const stats = {
    ...createTokenUsageStats(),
    apiUsageAvailable: true,
    apiPromptTokens: 20,
    apiCompletionTokens: 2,
    apiCacheUsageAvailable: true,
    apiCacheReadTokens: 4,
    estimatedPromptTokens: 30,
    estimatedCompletionTokens: 3,
    performanceSamples: [{ ...sample, firstTextDeltaMs: 1 }],
  };
  const normalized = validateTokenUsage(stats);
  expect(normalized).toMatchObject({
    apiTotalTokens: 22,
    estimatedTotalTokens: 33,
    apiCacheReadTokens: 4,
  });
  stats.performanceSamples[0].durationMs = 999;
  expect(normalized.performanceSamples?.[0].durationMs).toBe(10);
  expect(isContainerOutput({ ...output, tokenUsage: normalized })).toBe(true);
});

test('accepts snapshots without optional timing samples without inventing reported API usage', () => {
  const stats = createTokenUsageStats();
  delete stats.performanceSamples;
  expect(isContainerOutput({ ...output, tokenUsage: stats })).toBe(true);
  expect(validateTokenUsage(stats)).toMatchObject({
    apiUsageAvailable: false,
    apiCacheUsageAvailable: false,
  });
});

test.each([
  ['missing counter', { modelCalls: undefined }],
  ['nonfinite count', { modelCalls: Number.POSITIVE_INFINITY }],
  ['negative cache', { apiCacheReadTokens: -1 }],
  ['fractional tokens', { apiCompletionTokens: 1.5 }],
  ['invalid cache availability', { apiCacheUsageAvailable: 'true' }],
  [
    'overflowing estimate',
    {
      estimatedPromptTokens: Number.MAX_SAFE_INTEGER,
      estimatedCompletionTokens: 1,
    },
  ],
  [
    'overflowing API total',
    {
      apiUsageAvailable: true,
      apiPromptTokens: Number.MAX_SAFE_INTEGER,
      apiCompletionTokens: 1,
      apiTotalTokens: 0,
    },
  ],
  ['invalid samples', { performanceSamples: {} }],
  ['invalid sample', { performanceSamples: [null] }],
  [
    'fractional timing',
    { performanceSamples: [{ ...sample, durationMs: 0.5 }] },
  ],
  [
    'missing sample counter',
    { performanceSamples: [{ ...sample, promptTokens: undefined }] },
  ],
  [
    'invalid first delta',
    { performanceSamples: [{ ...sample, firstTextDeltaMs: -1 }] },
  ],
])('worker IPC and recovery reject %s', (_label, fields) => {
  const stats = { ...createTokenUsageStats(), ...fields };
  expect(() => validateTokenUsage(stats)).toThrow();
  expect(isContainerOutput({ ...output, tokenUsage: stats })).toBe(false);
});
