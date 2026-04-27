export type ModelCapability = 'jsonMode' | 'reasoning' | 'tools' | 'vision';

export interface StaticModelMetadataEntry {
  contextWindow: number | null;
  maxTokens?: number | null;
  pricing: {
    inputPerMillion: number;
    outputPerMillion: number;
    currency: 'USD';
  } | null;
  capabilities: ModelCapability[];
  sources: string[];
}

export const MODEL_METADATA_DATA_VERSION = '2026-04-27';

export const MODEL_METADATA_USD_TO_EUR = {
  rateDate: '2026-04-24',
  usdPerEur: 1.1712,
  source: 'https://www.ecb.europa.eu/stats/eurofxref',
};

export const MODEL_METADATA_SOURCES = {
  openaiPricing: 'https://platform.openai.com/docs/pricing',
  openaiModels: 'https://developers.openai.com/api/docs/models',
  anthropicPricing: 'https://docs.claude.com/en/docs/about-claude/pricing',
  anthropicModels: 'https://docs.claude.com/claude/docs/models-overview',
};

const openaiCoreCapabilities: ModelCapability[] = [
  'jsonMode',
  'reasoning',
  'tools',
  'vision',
];

const anthropicCoreCapabilities: ModelCapability[] = [
  'jsonMode',
  'reasoning',
  'tools',
  'vision',
];

export const STATIC_MODEL_METADATA: Record<string, StaticModelMetadataEntry> = {
  'gpt-4.1': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 2, outputPerMillion: 8, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-4.1-mini': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 0.4, outputPerMillion: 1.6, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-4.1-nano': {
    contextWindow: 1_047_576,
    pricing: { inputPerMillion: 0.1, outputPerMillion: 0.4, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-nano': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.4, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5-pro': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 120, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex-max': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 10, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.1-codex-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-chat-latest': {
    contextWindow: 128_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-codex': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.2-pro': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 21, outputPerMillion: 168, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiPricing],
  },
  'gpt-5.3-codex': {
    contextWindow: 400_000,
    pricing: null,
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.3-codex-spark': {
    contextWindow: 128_000,
    pricing: null,
    capabilities: openaiCoreCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.4': {
    contextWindow: 1_050_000,
    pricing: { inputPerMillion: 2.5, outputPerMillion: 15, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'gpt-5.4-mini': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.75, outputPerMillion: 4.5, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'gpt-5.4-nano': {
    contextWindow: 400_000,
    pricing: { inputPerMillion: 0.2, outputPerMillion: 1.25, currency: 'USD' },
    capabilities: openaiCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.openaiModels,
      MODEL_METADATA_SOURCES.openaiPricing,
    ],
  },
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-haiku-4.5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 5, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-opus-4-1': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 75, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-opus-4.1': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    pricing: { inputPerMillion: 15, outputPerMillion: 75, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
  'claude-sonnet-4.5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    capabilities: anthropicCoreCapabilities,
    sources: [
      MODEL_METADATA_SOURCES.anthropicModels,
      MODEL_METADATA_SOURCES.anthropicPricing,
    ],
  },
} as const;
