import { collectModelLookupCandidates } from './model-lookup.js';

export interface ModelCapabilityFlags {
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  reasoning: boolean;
}

/**
 * Prompt-destined, byte-stable model overlay text. String fields must be
 * non-empty when an overlay is populated.
 */
export interface ModelOverlay {
  tool_discipline: string;
  completion_contract: string;
  execution_policy: string;
  narrate_only_retry: boolean;
}

interface StaticModelMetadataEntry {
  contextWindow: number | null;
  maxTokens?: number | null;
  capabilities: ModelCapabilityFlags;
  sources: string[];
  model_overlay?: ModelOverlay;
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
  'gpt-5.6-sol': {
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.6-terra': {
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    capabilities: coreModelCapabilities,
    sources: [MODEL_METADATA_SOURCES.openaiModels],
  },
  'gpt-5.6-luna': {
    contextWindow: 400_000,
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
  'claude-sonnet-5': {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
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

const GPT5_OVERLAY_MODEL_IDS = new Set([
  // Canonical GPT-5 overlay family requested by #994. This is intentionally
  // narrower than every gpt-5* static catalog entry.
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
]);

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
  return findStaticModelMetadataEntryFromCandidates(
    collectModelLookupCandidates(modelName),
  );
}

function findStaticModelMetadataEntryFromCandidates(
  candidates: readonly string[],
): StaticModelMetadataEntry | null {
  for (const candidate of candidates) {
    const directKey = resolveStaticMetadataEntryKey(candidate);
    if (directKey) return STATIC_MODEL_METADATA[directKey] ?? null;
  }

  return null;
}

function candidatesIncludeGpt5ModelId(candidates: readonly string[]): boolean {
  return candidates.some((candidate) => GPT5_OVERLAY_MODEL_IDS.has(candidate));
}

export function isGpt5ModelId(modelId: string): boolean {
  return candidatesIncludeGpt5ModelId(collectModelLookupCandidates(modelId));
}

export function isCodexFamilyModelId(_modelId: string): boolean {
  return false;
}

export function isLocalLlmModelId(_modelId: string): boolean {
  return false;
}

const MODEL_OVERLAY_MATCHERS: {
  matches: (modelId: string) => boolean;
  overlay: ModelOverlay | undefined;
}[] = [
  { matches: isGpt5ModelId, overlay: undefined },
  { matches: isCodexFamilyModelId, overlay: undefined },
  { matches: isLocalLlmModelId, overlay: undefined },
];

function matchesModelOverlayCandidate(
  matcher: (modelId: string) => boolean,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => matcher(candidate));
}

export function getModelOverlay(modelId: string): ModelOverlay | undefined {
  const candidates = collectModelLookupCandidates(modelId);
  const entry = findStaticModelMetadataEntryFromCandidates(candidates);
  if (entry?.model_overlay) return entry.model_overlay;

  for (const matcher of MODEL_OVERLAY_MATCHERS) {
    if (matchesModelOverlayCandidate(matcher.matches, candidates)) {
      return matcher.overlay;
    }
  }

  return undefined;
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
