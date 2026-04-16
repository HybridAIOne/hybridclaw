import { describe, expect, test } from 'vitest';

import {
  formatHybridAIModelForCatalog,
  formatModelForDisplay,
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

  test('formatModelForDisplay leaves provider-prefixed models untouched', () => {
    // Existing providers that used to be whitelisted.
    expect(formatModelForDisplay('openrouter/anthropic/claude-sonnet-4.6')).toBe(
      'openrouter/anthropic/claude-sonnet-4.6',
    );
    expect(formatModelForDisplay('mistral/mistral-large-latest')).toBe(
      'mistral/mistral-large-latest',
    );
    // Newer OpenAI-compat providers — must not get a `hybridai/` prefix added.
    expect(formatModelForDisplay('kilo/anthropic/claude-sonnet-4.6')).toBe(
      'kilo/anthropic/claude-sonnet-4.6',
    );
    expect(formatModelForDisplay('gemini/gemini-2.5-pro')).toBe(
      'gemini/gemini-2.5-pro',
    );
    expect(formatModelForDisplay('dashscope/qwen3-coder-plus')).toBe(
      'dashscope/qwen3-coder-plus',
    );
  });

  test('formatModelForDisplay prepends hybridai/ only to bare model names', () => {
    expect(formatModelForDisplay('gpt-5-nano')).toBe('hybridai/gpt-5-nano');
    expect(formatModelForDisplay('hybridai/gpt-5-nano')).toBe(
      'hybridai/gpt-5-nano',
    );
    expect(formatModelForDisplay('')).toBe('');
  });
});
