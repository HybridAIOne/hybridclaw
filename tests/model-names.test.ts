import { describe, expect, test } from 'vitest';

import {
  formatHybridAIModelForCatalog,
  stripHybridAIModelPrefix,
  stripProviderPrefix,
} from '../src/providers/model-names.js';

describe('model name helpers', () => {
  test('stripProviderPrefix removes matched provider prefixes case-insensitively', () => {
    expect(stripProviderPrefix('openai-codex/gpt-5.4', 'openai-codex')).toBe(
      'gpt-5.4',
    );
    expect(stripProviderPrefix('OLLAMA/llama3.2', 'ollama')).toBe('llama3.2');
  });

  test('stripProviderPrefix preserves unmatched or empty upstream names', () => {
    expect(
      stripProviderPrefix('anthropic/claude-sonnet-4', 'openai-codex'),
    ).toBe('anthropic/claude-sonnet-4');
    expect(stripProviderPrefix('openai-codex/', 'openai-codex')).toBe(
      'openai-codex/',
    );
  });

  test('stripHybridAIModelPrefix preserves prefix-only inputs instead of returning an empty model', () => {
    expect(stripHybridAIModelPrefix('hybridai/gpt-5-nano')).toBe('gpt-5-nano');
    expect(stripHybridAIModelPrefix('hybridai/')).toBe('hybridai/');
  });

  test('formatHybridAIModelForCatalog still drops prefix-only hybridai inputs', () => {
    expect(formatHybridAIModelForCatalog('hybridai/')).toBe('');
  });
});
