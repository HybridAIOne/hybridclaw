import { describe, expect, it } from 'vitest';
import {
  inferProviderFromModelPrefix,
  RUNTIME_PROVIDER_IDS,
} from '#shared/provider-ids.js';
import { GATEWAY_MODEL_PROVIDER_KEYS } from '../src/gateway/model-provider-keys.js';
import { PROVIDER_META } from '../src/providers/provider-meta.js';

describe('provider ids', () => {
  it.each([
    ['openai/gpt-5.6-sol', 'openai'],
    ['openai-codex/gpt-5.4', 'openai-codex'],
    ['MLX/mlx-community/Qwen3', 'mlx'],
    ['kilo/anthropic/claude-sonnet-4.6', 'kilo'],
    [' xiaomi/mimo ', 'xiaomi'],
    ['gpt-4.1-mini', undefined],
    ['hybridai/gpt-5', undefined],
    ['my-endpoint/llama', undefined],
  ])('infers the provider of %j as %j', (model, provider) => {
    expect(inferProviderFromModelPrefix(model)).toBe(provider);
  });

  it('maps every runtime provider to a distinct gateway key', () => {
    expect(new Set(GATEWAY_MODEL_PROVIDER_KEYS).size).toBe(
      RUNTIME_PROVIDER_IDS.length,
    );
    expect(GATEWAY_MODEL_PROVIDER_KEYS).toContain('codex');
    expect(GATEWAY_MODEL_PROVIDER_KEYS).not.toContain('openai-codex');
  });

  it('gives every provider a distinct label', () => {
    const labels = RUNTIME_PROVIDER_IDS.map((id) => PROVIDER_META[id].label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
