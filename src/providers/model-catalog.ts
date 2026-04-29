import { HYBRIDAI_MODEL } from '../config/config.js';
import { getRuntimeConfig } from '../config/runtime-config.js';
import {
  discoverAnthropicModels,
  getDiscoveredAnthropicModelContextWindow,
  getDiscoveredAnthropicModelNames,
  getDiscoveredAnthropicModelPricingUsdPerToken,
  isDiscoveredAnthropicModelVisionCapable,
} from './anthropic-discovery.js';
import { ANTHROPIC_MODEL_PREFIX } from './anthropic-utils.js';
import {
  discoverCodexModels,
  getDiscoveredCodexModelContextWindow,
  getDiscoveredCodexModelMaxTokens,
  getDiscoveredCodexModelNames,
  getDiscoveredCodexModelPricingUsdPerToken,
} from './codex-discovery.js';
import { resolveModelProvider } from './factory.js';
import {
  discoverHuggingFaceModels,
  getDiscoveredHuggingFaceModelContextWindow,
  getDiscoveredHuggingFaceModelPricingUsdPerToken,
} from './huggingface-discovery.js';
import { HUGGINGFACE_MODEL_PREFIX } from './huggingface-utils.js';
import {
  discoverHybridAIModels,
  getDiscoveredHybridAIModelContextWindow,
  getDiscoveredHybridAIModelMaxTokens,
  getDiscoveredHybridAIModelNames,
  getDiscoveredHybridAIModelPricingUsdPerToken,
} from './hybridai-discovery.js';
import { isStaticModelVisionCapable } from './hybridai-models.js';
import {
  discoverAllLocalModels,
  getDiscoveredLocalModelNames,
  getLocalModelInfo,
  resolveLocalModelContextWindow,
} from './local-discovery.js';
import {
  discoverMistralModels,
  getDiscoveredMistralModelContextWindow,
  getDiscoveredMistralModelPricingUsdPerToken,
  isDiscoveredDeprecatedMistralModel,
  isDiscoveredMistralModelVisionCapable,
  resolveDiscoveredMistralModelCanonicalName,
} from './mistral-discovery.js';
import { MISTRAL_MODEL_PREFIX } from './mistral-utils.js';
import {
  type ModelCapabilityFlags,
  resolveStaticModelCatalogMetadata,
  type StaticModelCatalogMetadata,
} from './model-metadata.js';
import {
  formatHybridAIModelForCatalog,
  formatModelForDisplay,
} from './model-names.js';
import { OPENAI_CODEX_MODEL_PREFIX } from './openai.js';
import {
  discoverOpenAICompatRemoteModels,
  getDiscoveredOpenAICompatRemoteModelNames,
  getDiscoveredOpenAICompatRemoteModelPricingUsdPerToken,
} from './openai-compat-discovery.js';
import { OPENAI_COMPAT_REMOTE_PROVIDERS } from './openai-compat-remote.js';
import {
  discoverOpenRouterModels,
  getDiscoveredOpenRouterModelContextWindow,
  getDiscoveredOpenRouterModelMaxTokens,
  getDiscoveredOpenRouterModelPricingUsdPerToken,
  isDiscoveredOpenRouterModelFree,
  isDiscoveredOpenRouterModelVisionCapable,
} from './openrouter-discovery.js';
import { OPENROUTER_MODEL_PREFIX } from './openrouter-utils.js';
import { PROVIDER_ALIASES } from './provider-aliases.js';
import { isRuntimeProviderId, type RuntimeProviderId } from './provider-ids.js';

export type ModelCatalogProviderFilter = RuntimeProviderId | 'local';

export interface ModelCatalogMetadata extends StaticModelCatalogMetadata {
  pricingUsdPerToken: {
    input: number | null;
    output: number | null;
  };
}

export type ModelCapabilityRequirements = Partial<ModelCapabilityFlags>;

export interface ModelCatalogSelection {
  model: string;
  metadata: ModelCatalogMetadata;
  estimatedUnitCostUsd: number | null;
}

export interface ModelCatalogSelectionOptions {
  models?: string[];
  excludeModels?: string[];
  provider?: string;
}

const OLLAMA_MODEL_PREFIX = 'ollama/';
const LMSTUDIO_MODEL_PREFIX = 'lmstudio/';
const LLAMACPP_MODEL_PREFIX = 'llamacpp/';
const VLLM_MODEL_PREFIX = 'vllm/';
const GEMINI_MODEL_PREFIX = 'gemini/';
const DEEPSEEK_MODEL_PREFIX = 'deepseek/';
const XAI_MODEL_PREFIX = 'xai/';
const ZAI_MODEL_PREFIX = 'zai/';
const KIMI_MODEL_PREFIX = 'kimi/';
const MINIMAX_MODEL_PREFIX = 'minimax/';
const DASHSCOPE_MODEL_PREFIX = 'dashscope/';
const XIAOMI_MODEL_PREFIX = 'xiaomi/';
const KILO_MODEL_PREFIX = 'kilo/';

const PREFIX_BY_PROVIDER: Record<
  Exclude<ModelCatalogProviderFilter, 'hybridai' | 'local'>,
  string
> = {
  'openai-codex': OPENAI_CODEX_MODEL_PREFIX,
  anthropic: ANTHROPIC_MODEL_PREFIX,
  openrouter: OPENROUTER_MODEL_PREFIX,
  mistral: MISTRAL_MODEL_PREFIX,
  huggingface: HUGGINGFACE_MODEL_PREFIX,
  gemini: GEMINI_MODEL_PREFIX,
  deepseek: DEEPSEEK_MODEL_PREFIX,
  xai: XAI_MODEL_PREFIX,
  zai: ZAI_MODEL_PREFIX,
  kimi: KIMI_MODEL_PREFIX,
  minimax: MINIMAX_MODEL_PREFIX,
  dashscope: DASHSCOPE_MODEL_PREFIX,
  xiaomi: XIAOMI_MODEL_PREFIX,
  kilo: KILO_MODEL_PREFIX,
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

function modelMeetsCapabilityRequirements(
  metadata: ModelCatalogMetadata,
  requirements: ModelCapabilityRequirements,
): boolean {
  for (const [capability, required] of Object.entries(requirements) as Array<
    [keyof ModelCapabilityFlags, boolean | undefined]
  >) {
    if (required === undefined) continue;
    if (metadata.capabilities[capability] !== required) return false;
  }
  return true;
}

function estimateModelUnitCostUsd(
  pricing: ModelCatalogMetadata['pricingUsdPerToken'],
): number | null {
  if (pricing.input == null && pricing.output == null) return null;
  const input = pricing.input ?? pricing.output ?? 0;
  const output = pricing.output ?? pricing.input ?? 0;
  return input + output;
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
  const alias = PROVIDER_ALIASES[normalized];
  if (alias) return alias;
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
    const originalModel = String(rawModel || '').trim();
    const model =
      resolveModelProvider(originalModel) === 'hybridai' &&
      !isLocalPrefixedModel(originalModel)
        ? formatHybridAIModelForCatalog(originalModel)
        : originalModel;
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

function collectModelsForProvider(
  filter: ModelCatalogProviderFilter,
): string[] {
  const config = getRuntimeConfig();
  switch (filter) {
    case 'hybridai':
      return [HYBRIDAI_MODEL, ...getDiscoveredHybridAIModelNames()];
    case 'openai-codex':
      return getDiscoveredCodexModelNames();
    case 'anthropic': {
      const discovered = getDiscoveredAnthropicModelNames();
      return discovered.length > 0
        ? discovered
        : config.anthropic.enabled
          ? config.anthropic.models
          : [];
    }
    case 'local':
    case 'ollama':
    case 'lmstudio':
    case 'llamacpp':
    case 'vllm':
      return getDiscoveredLocalModelNames();
    case 'openrouter':
    case 'mistral':
    case 'huggingface':
      return getDiscoveredOpenAICompatRemoteModelNames();
    case 'gemini':
    case 'deepseek':
    case 'xai':
    case 'zai':
    case 'kimi':
    case 'minimax':
    case 'dashscope':
    case 'xiaomi':
    case 'kilo': {
      const section = (config as unknown as Record<string, unknown>)[filter] as
        | { enabled: boolean; models: string[] }
        | undefined;
      return [
        ...getDiscoveredOpenAICompatRemoteModelNames(),
        ...(section?.enabled ? section.models : []),
      ];
    }
  }
}

export function getAvailableModelList(provider?: string): string[] {
  const config = getRuntimeConfig();
  const normalizedProvider = normalizeModelCatalogProviderFilter(provider);

  if (provider && normalizedProvider === null) return [];

  const rawModels = normalizedProvider
    ? collectModelsForProvider(normalizedProvider)
    : [
        HYBRIDAI_MODEL,
        ...getDiscoveredCodexModelNames(),
        ...collectModelsForProvider('anthropic'),
        ...getDiscoveredHybridAIModelNames(),
        ...getDiscoveredLocalModelNames(),
        ...getDiscoveredOpenAICompatRemoteModelNames(),
        ...OPENAI_COMPAT_REMOTE_PROVIDERS.flatMap((def) => {
          const section = (config as unknown as Record<string, unknown>)[
            def.id
          ] as { enabled: boolean; models: string[] } | undefined;
          return section?.enabled ? section.models : [];
        }),
      ];

  const models = dedupeModelList(rawModels);

  if (!normalizedProvider) {
    return models.sort((left, right) => compareModelNames(left, right));
  }

  const filteredModels = models.filter((model) =>
    matchesProviderFilter(model, normalizedProvider),
  );
  if (normalizedProvider === 'anthropic') return filteredModels;
  return filteredModels.sort((left, right) =>
    compareModelNames(left, right, normalizedProvider),
  );
}

export async function refreshAvailableModelCatalogs(opts?: {
  includeHybridAI?: boolean;
}): Promise<void> {
  await Promise.allSettled([
    discoverCodexModels(),
    discoverAnthropicModels(),
    discoverAllLocalModels(),
    discoverHuggingFaceModels(),
    discoverMistralModels(),
    discoverOpenRouterModels(),
    discoverOpenAICompatRemoteModels(),
    ...(opts?.includeHybridAI ? [discoverHybridAIModels()] : []),
  ]);
}

export async function refreshModelCatalogMetadata(
  model: string,
): Promise<void> {
  const normalized = String(model || '').trim();
  if (!normalized) return;

  if (isLocalPrefixedModel(normalized)) {
    await discoverAllLocalModels();
    return;
  }
  if (hasModelPrefix(normalized, OPENAI_CODEX_MODEL_PREFIX)) {
    await discoverCodexModels();
    return;
  }
  if (hasModelPrefix(normalized, ANTHROPIC_MODEL_PREFIX)) {
    await discoverAnthropicModels();
    return;
  }
  if (hasModelPrefix(normalized, OPENROUTER_MODEL_PREFIX)) {
    await discoverOpenRouterModels();
    return;
  }
  if (hasModelPrefix(normalized, MISTRAL_MODEL_PREFIX)) {
    await discoverMistralModels();
    return;
  }
  if (hasModelPrefix(normalized, HUGGINGFACE_MODEL_PREFIX)) {
    await discoverHuggingFaceModels();
    return;
  }
  for (const { prefix } of OPENAI_COMPAT_REMOTE_PROVIDERS) {
    if (hasModelPrefix(normalized, prefix)) {
      await discoverOpenAICompatRemoteModels();
      return;
    }
  }
  await discoverHybridAIModels();
}

function resolveKnownModelContextWindow(
  model: string,
  staticMetadata: StaticModelCatalogMetadata,
): number | null {
  return (
    resolveLocalModelContextWindow(model) ??
    getDiscoveredCodexModelContextWindow(model) ??
    getDiscoveredHuggingFaceModelContextWindow(model) ??
    getDiscoveredHybridAIModelContextWindow(model) ??
    getDiscoveredMistralModelContextWindow(model) ??
    getDiscoveredAnthropicModelContextWindow(model) ??
    getDiscoveredOpenRouterModelContextWindow(model) ??
    staticMetadata.contextWindow
  );
}

function resolveKnownModelMaxTokens(
  model: string,
  staticMetadata: StaticModelCatalogMetadata,
): number | null {
  const info = getLocalModelInfo(model);
  return (
    info?.maxTokens ??
    getDiscoveredCodexModelMaxTokens(model) ??
    getDiscoveredHybridAIModelMaxTokens(model) ??
    getDiscoveredOpenRouterModelMaxTokens(model) ??
    staticMetadata.maxTokens
  );
}

function resolveKnownModelPricingUsdPerToken(
  model: string,
): ModelCatalogMetadata['pricingUsdPerToken'] {
  if (isLocalPrefixedModel(model)) {
    return { input: 0, output: 0 };
  }
  if (hasModelPrefix(model, OPENAI_CODEX_MODEL_PREFIX)) {
    return (
      getDiscoveredCodexModelPricingUsdPerToken(model) ?? {
        input: null,
        output: null,
      }
    );
  }
  return (
    getDiscoveredHybridAIModelPricingUsdPerToken(model) ??
    getDiscoveredOpenRouterModelPricingUsdPerToken(model) ??
    getDiscoveredMistralModelPricingUsdPerToken(model) ??
    getDiscoveredHuggingFaceModelPricingUsdPerToken(model) ??
    getDiscoveredAnthropicModelPricingUsdPerToken(model) ??
    getDiscoveredOpenAICompatRemoteModelPricingUsdPerToken(model) ?? {
      input: null,
      output: null,
    }
  );
}

export function getModelCatalogMetadata(model: string): ModelCatalogMetadata {
  const staticMetadata = resolveStaticModelCatalogMetadata(model);
  const contextWindow = resolveKnownModelContextWindow(model, staticMetadata);
  const maxTokens = resolveKnownModelMaxTokens(model, staticMetadata);
  const pricingUsdPerToken = resolveKnownModelPricingUsdPerToken(model);
  const vision = isModelVisionCapable(model);

  return {
    ...staticMetadata,
    known:
      staticMetadata.known ||
      contextWindow != null ||
      maxTokens != null ||
      vision,
    contextWindow,
    maxTokens,
    pricingUsdPerToken,
    capabilities: {
      ...staticMetadata.capabilities,
      vision,
    },
  };
}

export function selectModelsByCapabilityAndCost(
  requirements: ModelCapabilityRequirements,
  options: ModelCatalogSelectionOptions = {},
): ModelCatalogSelection[] {
  const excluded = new Set(
    (options.excludeModels || []).map((model) => model.trim()).filter(Boolean),
  );
  const models = dedupeModelList(
    options.models || getAvailableModelList(options.provider),
  ).filter((model) => !excluded.has(model));

  return models
    .map((model) => {
      const metadata = getModelCatalogMetadata(model);
      if (!modelMeetsCapabilityRequirements(metadata, requirements)) {
        return null;
      }
      return {
        model,
        metadata,
        estimatedUnitCostUsd: estimateModelUnitCostUsd(
          metadata.pricingUsdPerToken,
        ),
      };
    })
    .filter((entry): entry is ModelCatalogSelection => entry != null)
    .sort((left, right) => {
      const leftCost = left.estimatedUnitCostUsd;
      const rightCost = right.estimatedUnitCostUsd;
      if (leftCost != null && rightCost != null && leftCost !== rightCost) {
        return leftCost - rightCost;
      }
      if (leftCost != null && rightCost == null) return -1;
      if (leftCost == null && rightCost != null) return 1;
      return compareModelNames(left.model, right.model);
    });
}

export function findCheapestModelMeetingCapabilities(
  requirements: ModelCapabilityRequirements,
  options: ModelCatalogSelectionOptions = {},
): string | null {
  return (
    selectModelsByCapabilityAndCost(requirements, options)[0]?.model ?? null
  );
}

/**
 * Returns true if the model is known to support vision (image input).
 * Checks both OpenRouter discovery data and the static capability list.
 */
export function isModelVisionCapable(model: string): boolean {
  const normalized = String(model || '').trim();
  if (!normalized) return false;
  if (hasModelPrefix(normalized, OPENROUTER_MODEL_PREFIX)) {
    return isDiscoveredOpenRouterModelVisionCapable(normalized);
  }
  return (
    isDiscoveredMistralModelVisionCapable(normalized) ||
    isDiscoveredAnthropicModelVisionCapable(normalized) ||
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
