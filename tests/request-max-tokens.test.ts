import { describe, expect, test } from 'vitest';

import {
  DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS as containerDefaultAnthropicProviderMaxTokens,
  resolveProviderRequestMaxTokens as resolveContainerRequestMaxTokens,
} from '../container/src/providers/request-max-tokens.js';
import {
  DEFAULT_ANTHROPIC_PROVIDER_MAX_TOKENS as hostDefaultAnthropicProviderMaxTokens,
  resolveProviderRequestMaxTokens as resolveHostRequestMaxTokens,
} from '../src/providers/request-max-tokens.js';

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
  'host request max token policy',
  resolveHostRequestMaxTokens,
  hostDefaultAnthropicProviderMaxTokens,
);

runSharedContract(
  'container request max token policy',
  resolveContainerRequestMaxTokens,
  containerDefaultAnthropicProviderMaxTokens,
);
