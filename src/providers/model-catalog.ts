import { CONFIGURED_MODELS } from '../config/config.js';
import { resolveModelProvider } from './factory.js';
import {
  discoverAllLocalModels,
  getDiscoveredLocalModelNames,
} from './local-discovery.js';
import {
  discoverOpenRouterModels,
  getDiscoveredOpenRouterModelNames,
  isDiscoveredOpenRouterModelFree,
} from './openrouter-discovery.js';

type ModelCatalogProviderFilter =
  | 'hybridai'
  | 'openai-codex'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'vllm'
  | 'local';

const OPENAI_CODEX_MODEL_PREFIX = 'openai-codex/';
const OPENROUTER_MODEL_PREFIX = 'openrouter/';
const OLLAMA_MODEL_PREFIX = 'ollama/';
const LMSTUDIO_MODEL_PREFIX = 'lmstudio/';
const VLLM_MODEL_PREFIX = 'vllm/';
const PREFIX_BY_PROVIDER: Record<
  Extract<
    ModelCatalogProviderFilter,
    'openai-codex' | 'openrouter' | 'ollama' | 'lmstudio' | 'vllm'
  >,
  string
> = {
  'openai-codex': OPENAI_CODEX_MODEL_PREFIX,
  openrouter: OPENROUTER_MODEL_PREFIX,
  ollama: OLLAMA_MODEL_PREFIX,
  lmstudio: LMSTUDIO_MODEL_PREFIX,
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
  if (
    normalized === 'hybridai' ||
    normalized === 'openai-codex' ||
    normalized === 'openrouter' ||
    normalized === 'ollama' ||
    normalized === 'lmstudio' ||
    normalized === 'vllm' ||
    normalized === 'local'
  ) {
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
    seen.add(model);
    deduped.push(model);
  }
  return deduped;
}

export function getAvailableModelList(provider?: string): string[] {
  const models = dedupeModelList([
    ...CONFIGURED_MODELS,
    ...getDiscoveredLocalModelNames(),
    ...getDiscoveredOpenRouterModelNames(),
  ]);
  const normalizedProvider = normalizeModelCatalogProviderFilter(provider);
  if (!provider) {
    return models.sort((left, right) => compareModelNames(left, right));
  }
  if (normalizedProvider === null) return [];
  return models
    .filter((model) => matchesProviderFilter(model, normalizedProvider))
    .sort((left, right) => compareModelNames(left, right, normalizedProvider));
}

export async function refreshAvailableModelCatalogs(): Promise<void> {
  await Promise.allSettled([
    discoverAllLocalModels(),
    discoverOpenRouterModels(),
  ]);
}

export async function getAvailableModelChoices(
  limit = 25,
): Promise<Array<{ name: string; value: string }>> {
  await refreshAvailableModelCatalogs();
  return getAvailableModelList()
    .slice(0, Math.max(0, limit))
    .map((model) => ({
      name: model,
      value: model,
    }));
}
