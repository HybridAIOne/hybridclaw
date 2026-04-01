import { CONFIGURED_MODELS } from '../config/config.js';
import { resolveModelProvider } from './factory.js';
import {
  discoverHuggingFaceModels,
  getDiscoveredHuggingFaceModelNames,
} from './huggingface-discovery.js';
import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import {
  discoverHybridAIModels,
  getDiscoveredHybridAIModelNames,
} from './hybridai-discovery.js';
import { isStaticModelVisionCapable } from './hybridai-models.js';
import {
  discoverAllLocalModels,
  getDiscoveredLocalModelNames,
} from './local-discovery.js';
import {
  discoverMistralModels,
  getDiscoveredMistralModelNames,
  isDiscoveredDeprecatedMistralModel,
  isDiscoveredMistralModelVisionCapable,
  resolveDiscoveredMistralModelCanonicalName,
} from './mistral-discovery.js';
import { MISTRAL_MODEL_PREFIX } from './mistral-utils.js';
import { formatModelForDisplay } from './model-names.js';
import { OPENAI_CODEX_MODEL_PREFIX } from './openai.js';
import {
  discoverOpenRouterModels,
  getDiscoveredOpenRouterModelNames,
  isDiscoveredOpenRouterModelFree,
  isDiscoveredOpenRouterModelVisionCapable,
} from './openrouter-discovery.js';
import { OPENROUTER_MODEL_PREFIX } from './openrouter-utils.js';
import { isRuntimeProviderId, type RuntimeProviderId } from './provider-ids.js';

type ModelCatalogProviderFilter = RuntimeProviderId | 'local';

const OLLAMA_MODEL_PREFIX = 'ollama/';
const LMSTUDIO_MODEL_PREFIX = 'lmstudio/';
const LLAMACPP_MODEL_PREFIX = 'llamacpp/';
const VLLM_MODEL_PREFIX = 'vllm/';
const PREFIX_BY_PROVIDER: Record<
  Extract<
    ModelCatalogProviderFilter,
    | 'openai-codex'
    | 'openrouter'
    | 'mistral'
    | 'huggingface'
    | 'ollama'
    | 'lmstudio'
    | 'llamacpp'
    | 'vllm'
  >,
  string
> = {
  'openai-codex': OPENAI_CODEX_MODEL_PREFIX,
  openrouter: OPENROUTER_MODEL_PREFIX,
  mistral: MISTRAL_MODEL_PREFIX,
  huggingface: HUGGINGFACE_MODEL_PREFIX,
  ollama: OLLAMA_MODEL_PREFIX,
  lmstudio: LMSTUDIO_MODEL_PREFIX,
  llamacpp: LLAMACPP_MODEL_PREFIX,
  vllm: VLLM_MODEL_PREFIX,
};

function compareModelNames(
  left: string,
  right: string,
  providerFilter?: ModelCatalogProviderFilter | null,
): number {
  if (providerFilter === 'openrouter') {
    const leftIsFree = isAvailableModelFree(left);
    const rightIsFree = isAvailableModelFree(right);
    if (leftIsFree !== rightIsFree) {
      return leftIsFree ? -1 : 1;
    }
  }
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function isAvailableModelFree(model: string): boolean {
  const normalized = String(model || '').trim();
  return (
    normalized.toLowerCase().startsWith(OPENROUTER_MODEL_PREFIX) &&
    isDiscoveredOpenRouterModelFree(normalized)
  );
}

function hasModelPrefix(model: string, prefix: string): boolean {
  return String(model || '')
    .trim()
    .toLowerCase()
    .startsWith(prefix);
}

function isLocalPrefixedModel(model: string): boolean {
  return (
    hasModelPrefix(model, PREFIX_BY_PROVIDER.ollama) ||
    hasModelPrefix(model, PREFIX_BY_PROVIDER.lmstudio) ||
    hasModelPrefix(model, PREFIX_BY_PROVIDER.llamacpp) ||
    hasModelPrefix(model, PREFIX_BY_PROVIDER.vllm)
  );
}

export function normalizeModelCatalogProviderFilter(
  value: string | undefined,
): ModelCatalogProviderFilter | null {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (normalized === 'codex') return 'openai-codex';
  if (normalized === 'local' || isRuntimeProviderId(normalized)) {
    return normalized;
  }
  return null;
}

function matchesProviderFilter(
  model: string,
  providerFilter: ModelCatalogProviderFilter,
): boolean {
  const normalized = String(model || '').trim();
  if (!normalized) return false;

  const prefix =
    providerFilter === 'local' || providerFilter === 'hybridai'
      ? null
      : PREFIX_BY_PROVIDER[providerFilter];
  if (prefix) {
    return hasModelPrefix(normalized, prefix);
  }
  if (providerFilter === 'local') return isLocalPrefixedModel(normalized);

  const provider = resolveModelProvider(normalized);
  if (providerFilter === 'hybridai') {
    return provider === 'hybridai' && !isLocalPrefixedModel(normalized);
  }
  return provider === providerFilter;
}

function dedupeModelList(models: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawModel of models) {
    const model = String(rawModel || '').trim();
    if (!model || seen.has(model)) continue;
    const canonicalModel = hasModelPrefix(model, MISTRAL_MODEL_PREFIX)
      ? resolveDiscoveredMistralModelCanonicalName(model)
      : model;
    if (!canonicalModel || seen.has(canonicalModel)) continue;
    if (
      hasModelPrefix(canonicalModel, MISTRAL_MODEL_PREFIX) &&
      isDiscoveredDeprecatedMistralModel(canonicalModel)
    ) {
      continue;
    }
    seen.add(canonicalModel);
    deduped.push(canonicalModel);
  }
  return deduped;
}

export function getAvailableModelList(provider?: string): string[] {
  return getAvailableModelListWithOptions(provider);
}

export function getAvailableModelListWithOptions(
  provider?: string,
  _opts?: { expanded?: boolean },
): string[] {
  const models = dedupeModelList([
    ...CONFIGURED_MODELS,
    ...getDiscoveredHuggingFaceModelNames(),
    ...getDiscoveredHybridAIModelNames(),
    ...getDiscoveredLocalModelNames(),
    ...getDiscoveredMistralModelNames(),
    ...getDiscoveredOpenRouterModelNames(),
  ]);
  const normalizedProvider = normalizeModelCatalogProviderFilter(provider);
  if (!provider) {
    return models.sort((left, right) => compareModelNames(left, right));
  }
  if (normalizedProvider === null) return [];
  const filteredModels = models.filter((model) =>
    matchesProviderFilter(model, normalizedProvider),
  );
  return filteredModels.sort((left, right) =>
    compareModelNames(left, right, normalizedProvider),
  );
}

export async function refreshAvailableModelCatalogs(opts?: {
  includeHybridAI?: boolean;
}): Promise<void> {
  await Promise.allSettled([
    discoverAllLocalModels(),
    discoverHuggingFaceModels(),
    discoverMistralModels(),
    discoverOpenRouterModels(),
    ...(opts?.includeHybridAI ? [discoverHybridAIModels()] : []),
  ]);
}

/**
 * Returns true if the model is known to support vision (image input).
 * Checks both OpenRouter discovery data and the static capability list.
 */
export function isModelVisionCapable(model: string): boolean {
  const normalized = String(model || '').trim();
  if (!normalized) return false;
  return (
    isDiscoveredMistralModelVisionCapable(normalized) ||
    isDiscoveredOpenRouterModelVisionCapable(normalized) ||
    isStaticModelVisionCapable(normalized)
  );
}

/**
 * Returns the first vision-capable model from the available model list,
 * preferring models from the same provider prefix as `preferredModel`.
 * Returns null if no vision-capable model is found.
 */
export function findVisionCapableModel(preferredModel?: string): string | null {
  const allModels = getAvailableModelList();
  const visionModels = allModels.filter((m) => isModelVisionCapable(m));
  if (visionModels.length === 0) return null;

  // Prefer a model from the same provider as the preferred model.
  if (preferredModel) {
    const slashIndex = preferredModel.indexOf('/');
    if (slashIndex > 0) {
      const prefix = preferredModel.slice(0, slashIndex + 1).toLowerCase();
      const sameProvider = visionModels.find((m) =>
        m.toLowerCase().startsWith(prefix),
      );
      if (sameProvider) return sameProvider;
    }
  }

  return visionModels[0];
}

export async function getAvailableModelChoices(
  limit = 25,
  opts?: { includeHybridAI?: boolean },
): Promise<Array<{ name: string; value: string }>> {
  await refreshAvailableModelCatalogs(opts);
  return getAvailableModelList()
    .slice(0, Math.max(0, limit))
    .map((model) => ({
      name: formatModelForDisplay(model),
      value: model,
    }));
}
