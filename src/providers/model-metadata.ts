import { collectModelLookupCandidates } from './model-lookup.js';

export interface ModelCapabilityFlags {
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  reasoning: boolean;
}

interface StaticModelMetadataEntry {
  contextWindow: number | null;
  maxTokens?: number | null;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency: 'USD';
  } | null;
  capabilities: ModelCapabilityFlags;
  sources: string[];
}

const MODEL_METADATA_SOURCES = {
  openaiPricing: 'https://platform.openai.com/docs/pricing',
  openaiModels: 'https://developers.openai.com/api/docs/models',
  anthropicPricing: 'https://docs.claude.com/en/docs/about-claude/pricing',
  anthropicModels: 'https://docs.claude.com/claude/docs/models-overview',
};

const STATIC_MODEL_METADATA_ALIASES: Record<string, string> = {
  'claude-haiku-4.5': 'claude-haiku-4-5',
  'claude-opus-4.1': 'claude-opus-4-1',
  'claude-opus-4.6': 'claude-opus-4-6',
  'claude-sonnet-4.5': 'claude-sonnet-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
};

const coreModelCapabilities: ModelCapabilityFlags = {
  vision: true,
  tools: true,
  jsonMode: true,
  reasoning: true,
};

const STATIC_MODEL_METADATA: Record<string, StaticModelMetadataEntry> = {
  'gpt-4.1': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-4.1-mini': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-4.1-nano': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-nano': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.4, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-pro': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 120, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex-max': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-pro': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 21, outputPerMillion: 168, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.3-codex': {
    contextWindow: 400_000,
    pricing: null,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.3-codex-spark': {
    contextWindow: 128_000,
    pricing: null,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.4': {
    contextWindow: 1_050_000,
    pricing: { inputPerMillion: 2.5, outputPerMillion: 15, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'gpt-5.4-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.75, outputPerMillion: 4.5, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'gpt-5.4-nano': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.2, outputPerMillion: 1.25, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-opus-4-1': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 75, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-opus-4-6': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 75, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4-6': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: coreModelCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
};

export interface ModelCatalogMetadata {
  known: boolean;
  pricingUsdPerToken: {
    input: number | null;
    output: number | null;
  };
  contextWindow: number | null;
  maxTokens: number | null;
  capabilities: ModelCapabilityFlags;
  sources: string[];
}

const EMPTY_CAPABILITIES: ModelCapabilityFlags = {
  vision: false,
  tools: false,
  jsonMode: false,
  reasoning: false,
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveStaticMetadataEntryKey(candidate: string): string | null {
  if (STATIC_MODEL_METADATA[candidate]) return candidate;
  const aliasTarget = STATIC_MODEL_METADATA_ALIASES[candidate];
  if (aliasTarget && STATIC_MODEL_METADATA[aliasTarget]) return aliasTarget;
  return null;
}

function findStaticModelMetadataEntry(
  modelName: string,
): StaticModelMetadataEntry | null {
  const candidates = collectModelLookupCandidates(modelName);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const directKey = resolveStaticMetadataEntryKey(candidate);
    if (directKey) return STATIC_MODEL_METADATA[directKey] ?? null;
  }

  return null;
}

function convertSourcePricingToUsdPerToken(
  entry: StaticModelMetadataEntry | null,
): ModelCatalogMetadata['pricingUsdPerToken'] {
  if (!entry?.pricing) return { input: null, output: null };
  return {
    input: entry.pricing.inputPerMillion / 1_000_000,
    output: entry.pricing.outputPerMillion / 1_000_000,
  };
}

export function resolveStaticModelCatalogMetadata(
  modelName: string,
): ModelCatalogMetadata {
  const entry = findStaticModelMetadataEntry(modelName);
  if (!entry) {
    return {
      known: false,
      pricingUsdPerToken: { input: null, output: null },
      contextWindow: null,
      maxTokens: null,
      capabilities: { ...EMPTY_CAPABILITIES },
      sources: [],
    };
  }

  return {
    known: true,
    pricingUsdPerToken: convertSourcePricingToUsdPerToken(entry),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? null,
    capabilities: entry.capabilities,
    sources: uniqueStrings(entry.sources),
  };
}
