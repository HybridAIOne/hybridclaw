import { describe, expect, test } from 'vitest';

import {
  DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS,
  resolveProviderRequestMaxTokens,
} from '@hybridclaw/shared/request-max-tokens';

function runSharedContract(
  label: string,
  resolve: (params: {
    provider?: string;
    model: string;
    requestedMaxTokens?: number;
    discoveredMaxTokens?: number;
    isLocal?: boolean;
    localDefaultMaxTokens?: number;
  }) => number | undefined,
  anthropicDefaultMaxTokens: number,
) {
  describe(label, () => {
    test('never sends max tokens for non-Anthropic models across providers', () => {
      expect(
        resolve({
          provider: 'openrouter',
          model: 'openrouter/openai/gpt-5',
          requestedMaxTokens: 777,
          discoveredMaxTokens: 64_000,
        }),
      ).toBeUndefined();

      expect(
        resolve({
          provider: 'hybridai',
          model: 'hybridai/gpt-5',
          requestedMaxTokens: 777,
          discoveredMaxTokens: 64_000,
        }),
      ).toBeUndefined();

      expect(
        resolve({
          provider: 'vllm',
          model: 'vllm/mistral-small',
          requestedMaxTokens: 777,
          isLocal: true,
          localDefaultMaxTokens: 16_384,
        }),
      ).toBeUndefined();

      expect(
        resolve({
          provider: 'openai-codex',
          model: 'openai-codex/gpt-5-codex',
          requestedMaxTokens: 777,
        }),
      ).toBeUndefined();
    });

    test('leaves MLX generation admission to the exact native tokenizer', () => {
      expect(resolve({ provider: 'mlx', model: 'mlx/spark-x2.5-4b', discoveredMaxTokens: 40960, isLocal: true })).toBeUndefined();
    });

    test('always sends discovered max tokens for Anthropic models when available', () => {
      expect(
        resolve({
          provider: 'openrouter',
          model: 'openrouter/anthropic/claude-sonnet-4',
          requestedMaxTokens: 777,
          discoveredMaxTokens: 64_000,
        }),
      ).toBe(64_000);

      expect(
        resolve({
          provider: 'hybridai',
          model: 'hybridai/anthropic/claude-3-7-sonnet',
          requestedMaxTokens: 777,
          discoveredMaxTokens: 48_000,
        }),
      ).toBe(48_000);
    });

    test('falls back to the Anthropic default when discovery metadata is missing', () => {
      expect(
        resolve({
          provider: 'openrouter',
          model: 'openrouter/anthropic/claude-sonnet-4',
          requestedMaxTokens: 777,
        }),
      ).toBe(anthropicDefaultMaxTokens);

      expect(
        resolve({
          provider: 'anthropic',
          model: 'anthropic/claude-sonnet-4',
        }),
      ).toBe(anthropicDefaultMaxTokens);
    });
  });
}

runSharedContract(
  'request max token policy',
  resolveProviderRequestMaxTokens,
  DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS,
);

test.each([
  [undefined, 131_072],
  [0, 131_072],
  [Number.NaN, 131_072],
  [Number.POSITIVE_INFINITY, 131_072],
  [16_384, 16_384],
  [32_768, 32_768],
  [131_072, 131_072],
  [262_144, 262_144],
])('Nebius reserves bounded reasoning and answer output with limit %s', (discoveredMaxTokens, expected) => {
  expect(resolveProviderRequestMaxTokens({
    model: 'nebius/zai-org/GLM-5.3-Flash',
    discoveredMaxTokens,
  })).toBe(expected);
});

test('Nebius models outside the verified GLM family retain their provider defaults', () => {
  expect(resolveProviderRequestMaxTokens({model: 'nebius/google/gemma-3-27b-it'})).toBeUndefined();
  expect(resolveProviderRequestMaxTokens({model: 'nebius/google/gemma-3-27b-it', discoveredMaxTokens: 8192})).toBe(8192);
});
