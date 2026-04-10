import { expect, test } from 'vitest';

import {
  isStaticModelVisionCapable,
  resolveModelContextWindowFallback,
  resolveModelContextWindowFromList,
} from '../src/providers/hybridai-models.js';

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
  expect(resolveModelContextWindowFallback('gpt-5-mini')).toBe(400_000);
  expect(resolveModelContextWindowFallback('gpt-4.1-mini')).toBe(1_047_576);
  expect(resolveModelContextWindowFallback('openai/gpt-5-nano')).toBe(400_000);
  expect(resolveModelContextWindowFallback('gpt-5:latest')).toBe(400_000);
  expect(resolveModelContextWindowFallback('gpt-5.1')).toBe(400_000);
  expect(resolveModelContextWindowFallback('gpt-5.3')).toBe(400_000);
  expect(resolveModelContextWindowFallback('openai-codex/gpt-5.4-mini')).toBe(
    272_000,
  );
  expect(resolveModelContextWindowFallback('openai-codex/gpt-5.4')).toBe(
    400_000,
  );
  expect(resolveModelContextWindowFallback('anthropic/claude-opus-4-6')).toBe(
    200_000,
  );
  expect(resolveModelContextWindowFallback('claude-sonnet-4.6')).toBe(200_000);
  expect(resolveModelContextWindowFallback('google/gemini-3.1-pro')).toBe(
    1_048_576,
  );
  expect(resolveModelContextWindowFallback('openai:gpt-5')).toBe(400_000);
  expect(resolveModelContextWindowFallback('openai/gpt-5:latest')).toBe(
    400_000,
  );
});

test('resolveModelContextWindowFallback returns null for unknown models', () => {
  expect(resolveModelContextWindowFallback('unknown-model')).toBeNull();
});

test('isStaticModelVisionCapable returns true for known vision models', () => {
  expect(isStaticModelVisionCapable('gpt-5')).toBe(true);
  expect(isStaticModelVisionCapable('gpt-5-mini')).toBe(true);
  expect(isStaticModelVisionCapable('gpt-4.1-mini')).toBe(true);
  expect(isStaticModelVisionCapable('gpt-5.4-mini')).toBe(true);
  expect(isStaticModelVisionCapable('gpt-5.3-codex')).toBe(true);
  expect(isStaticModelVisionCapable('claude-opus-4-6')).toBe(true);
  expect(isStaticModelVisionCapable('gemini-3-pro')).toBe(true);
});

test('isStaticModelVisionCapable strips provider prefix', () => {
  expect(isStaticModelVisionCapable('openai-codex/gpt-5')).toBe(true);
  expect(isStaticModelVisionCapable('anthropic/claude-sonnet-4-6')).toBe(true);
  expect(isStaticModelVisionCapable('openai:gpt-5')).toBe(true);
  expect(isStaticModelVisionCapable('gpt-5:latest')).toBe(true);
  expect(isStaticModelVisionCapable('openai/gpt-5:latest')).toBe(true);
});

test('isStaticModelVisionCapable returns false for non-vision models', () => {
  expect(isStaticModelVisionCapable('gpt-5-nano')).toBe(false);
  expect(isStaticModelVisionCapable('gpt-5.3-codex-spark')).toBe(false);
  expect(isStaticModelVisionCapable('gpt-5-chat-latest')).toBe(false);
  expect(isStaticModelVisionCapable('unknown-model')).toBe(false);
  expect(isStaticModelVisionCapable('')).toBe(false);
});
