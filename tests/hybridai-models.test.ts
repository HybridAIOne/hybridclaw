import { expect, test } from 'vitest';

import {
  resolveModelContextWindowFallback,
  resolveModelContextWindowFromList,
} from '../src/hybridai-models.js';

test('resolveModelContextWindowFromList matches exact model id', () => {
  const models = [
    { id: 'gpt-5-mini', contextWindowTokens: 272_000 },
    { id: 'gpt-5-nano', contextWindowTokens: 128_000 },
  ];

  expect(resolveModelContextWindowFromList(models, 'gpt-5-mini')).toBe(272_000);
});

test('resolveModelContextWindowFromList matches provider-prefixed tail', () => {
  const models = [{ id: 'openai/gpt-5', contextWindowTokens: 400_000 }];

  expect(resolveModelContextWindowFromList(models, 'gpt-5')).toBe(400_000);
});

test('resolveModelContextWindowFromList returns null when unresolved', () => {
  const models = [{ id: 'openai/gpt-5', contextWindowTokens: null }];

  expect(resolveModelContextWindowFromList(models, 'gpt-5')).toBeNull();
});

test('resolveModelContextWindowFallback resolves known defaults', () => {
  expect(resolveModelContextWindowFallback('gpt-5-mini')).toBe(272_000);
  expect(resolveModelContextWindowFallback('openai/gpt-5-nano')).toBe(128_000);
  expect(resolveModelContextWindowFallback('openai:gpt-5')).toBe(400_000);
});

test('resolveModelContextWindowFallback returns null for unknown models', () => {
  expect(resolveModelContextWindowFallback('unknown-model')).toBeNull();
});
