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
  capabilities: ModelCapabilityFlags;
  sources: string[];
}

const MODEL_METADATA_SOURCES = {
  openaiModels: 'https://developers.openai.com/api/docs/models',
  anthropicModels: 'https://docs.claude.com/claude/docs/models-overview',
};

export const MODEL_METADATA_USD_TO_EUR = {
  rateDate: '2026-04-24',
  usdPerEur: 1.1712,
  source: 'https://www.ecb.europa.eu/stats/eurofxref',
} as const;

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
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-4.1-mini': {
    contextWindow: 1_047_576,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-4.1-nano': {
    contextWindow: 1_047_576,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5-chat-latest': {
    contextWindow: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5-codex': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5-mini': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5-nano': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5-pro': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.1': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.1-chat-latest': {
    contextWindow: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.1-codex': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.1-codex-max': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.1-codex-mini': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.2': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.2-chat-latest': {
    contextWindow: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.2-codex': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.2-pro': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.3-codex': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.3-codex-spark': {
    contextWindow: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.4': {
    contextWindow: 1_050_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.4-mini': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.4-nano': {
    contextWindow: 400_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.5': {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.5-pro': {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'claude-haiku-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
  'claude-opus-4-1': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
  'claude-opus-4-6': {
    contextWindow: 200_000,
    maxTokens: 32_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
  'claude-sonnet-4': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
  'claude-sonnet-4-5': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
  'claude-sonnet-4-6': {
    contextWindow: 200_000,
    maxTokens: 64_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.anthropicModels],
  },
};

export interface StaticModelCatalogMetadata {
  known: boolean;
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

export function resolveStaticModelCatalogMetadata(
  modelName: string,
): StaticModelCatalogMetadata {
  const entry = findStaticModelMetadataEntry(modelName);
  if (!entry) {
    return {
      known: false,
      contextWindow: null,
      maxTokens: null,
      capabilities: { ...EMPTY_CAPABILITIES },
      sources: [],
    };
  }

  return {
    known: true,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? null,
    capabilities: entry.capabilities,
    sources: uniqueStrings(entry.sources),
  };
}
