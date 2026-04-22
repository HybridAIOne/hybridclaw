import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import { resolveDiscoveredMistralModelCanonicalName } from './mistral-discovery.js';
import { MISTRAL_MODEL_PREFIX } from './mistral-utils.js';
import { OPENROUTER_MODEL_PREFIX } from './openrouter-utils.js';

const HUGGINGFACE_RECOMMENDED_MODEL_IDS = [
  'Qwen/Qwen3.5-397B-A17B',
  'Qwen/Qwen3.5-35B-A3B',
  'deepseek-ai/DeepSeek-V3.2',
  'moonshotai/Kimi-K2.5',
  'MiniMaxAI/MiniMax-M2.5',
  'zai-org/GLM-5',
  'XiaomiMiMo/MiMo-V2-Flash',
  'moonshotai/Kimi-K2-Thinking',
] as const;

const OPENROUTER_RECOMMENDED_MODEL_IDS = [
  'qwen/qwen3.5-plus',
  'qwen/qwen3.5-35b-a3b',
  'deepseek/deepseek-chat',
  'moonshotai/kimi-k2.5',
  'minimax/minimax-m2.5',
  'z-ai/glm-5',
  'xiaomi/mimo-v2-pro',
  'moonshotai/kimi-k2-thinking',
  'nvidia/nemotron-3-super-120b-a12b',
] as const;

const MISTRAL_RECOMMENDED_MODEL_IDS = [
  'devstral-2512',
  'mistral-small-2603',
  'mistral-large-2512',
  'mistral-medium-2508',
  'ministral-14b-2512',
  'ministral-8b-2512',
  'ministral-3b-2512',
  'magistral-medium-2509',
] as const;

const SHARED_RECOMMENDED_FRAGMENTS = [
  'qwen3.5-27b',
  'nemotron-3-super-120b-a12b',
] as const;

const HUGGINGFACE_RECOMMENDED_MODEL_SET = new Set(
  HUGGINGFACE_RECOMMENDED_MODEL_IDS.map((modelId) => modelId.toLowerCase()),
);

const OPENROUTER_RECOMMENDED_MODEL_SET = new Set(
  OPENROUTER_RECOMMENDED_MODEL_IDS.map((modelId) => modelId.toLowerCase()),
);

const MISTRAL_RECOMMENDED_MODEL_SET = new Set(
  MISTRAL_RECOMMENDED_MODEL_IDS.map((modelId) => modelId.toLowerCase()),
);

function hasExactOrTaggedMatch(
  tail: string,
  modelSet: ReadonlySet<string>,
): boolean {
  if (modelSet.has(tail)) return true;
  const variantSeparatorIndex = tail.indexOf(':');
  if (variantSeparatorIndex === -1) return false;
  return modelSet.has(tail.slice(0, variantSeparatorIndex));
}

function hasFragmentMatch(tail: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => tail.includes(fragment));
}

function normalizeModelTail(model: string, prefix: string): string | null {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
}

export function isRecommendedModel(model: string): boolean {
  const huggingFaceTail = normalizeModelTail(model, HUGGINGFACE_MODEL_PREFIX);
  if (huggingFaceTail) {
    return (
      hasExactOrTaggedMatch(
        huggingFaceTail,
        HUGGINGFACE_RECOMMENDED_MODEL_SET,
      ) || hasFragmentMatch(huggingFaceTail, SHARED_RECOMMENDED_FRAGMENTS)
    );
  }

  const openRouterTail = normalizeModelTail(model, OPENROUTER_MODEL_PREFIX);
  if (openRouterTail) {
    return (
      hasExactOrTaggedMatch(openRouterTail, OPENROUTER_RECOMMENDED_MODEL_SET) ||
      hasFragmentMatch(openRouterTail, SHARED_RECOMMENDED_FRAGMENTS)
    );
  }

  const mistralTail = normalizeModelTail(model, MISTRAL_MODEL_PREFIX);
  if (mistralTail) {
    const canonical = resolveDiscoveredMistralModelCanonicalName(model);
    const canonicalTail =
      normalizeModelTail(canonical, MISTRAL_MODEL_PREFIX) ?? mistralTail;
    return hasExactOrTaggedMatch(canonicalTail, MISTRAL_RECOMMENDED_MODEL_SET);
  }

  return false;
}
