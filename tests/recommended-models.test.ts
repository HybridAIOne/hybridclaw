import { describe, expect, it } from 'vitest';
import { isRecommendedModel } from '../src/providers/recommended-models.js';

describe('isRecommendedModel', () => {
  it('marks curated Hugging Face models as recommended', () => {
    expect(isRecommendedModel('huggingface/Qwen/Qwen3.5-397B-A17B')).toBe(true);
    expect(isRecommendedModel('huggingface/XiaomiMiMo/MiMo-V2-Flash')).toBe(
      true,
    );
  });

  it('marks curated OpenRouter models as recommended', () => {
    expect(isRecommendedModel('openrouter/deepseek/deepseek-chat')).toBe(true);
    expect(
      isRecommendedModel('openrouter/nvidia/nemotron-3-super-120b-a12b'),
    ).toBe(true);
  });

  it('matches shared Qwen 3.5 27B fragments on both providers', () => {
    expect(isRecommendedModel('huggingface/Qwen/Qwen3.5-27B-FP8')).toBe(true);
    expect(isRecommendedModel('openrouter/qwen/qwen3.5-27b')).toBe(true);
  });

  it('keeps exact-match recommendations for tagged variants', () => {
    expect(
      isRecommendedModel('openrouter/nvidia/nemotron-3-super-120b-a12b:free'),
    ).toBe(true);
  });

  it('does not mark unrelated models as recommended', () => {
    expect(isRecommendedModel('huggingface/zeta/custom-model')).toBe(false);
    expect(isRecommendedModel('openrouter/alpha/model-a')).toBe(false);
  });
});
