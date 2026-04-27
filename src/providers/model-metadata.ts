import {
  collectModelLookupCandidates,
  matchesModelFamily,
} from './model-lookup.js';
import {
  MODEL_METADATA_DATA_VERSION,
  MODEL_METADATA_USD_TO_EUR,
  type ModelCapability,
  STATIC_MODEL_METADATA,
  type StaticModelMetadataEntry,
} from './model-metadata-data.js';

export interface ModelCapabilityFlags {
  vision: boolean;
  tools: boolean;
  jsonMode: boolean;
  reasoning: boolean;
}

export interface ModelCatalogMetadata {
  dataVersion: string;
  known: boolean;
  pricingEurPerToken: {
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

function findStaticModelMetadataEntry(
  modelName: string,
): StaticModelMetadataEntry | null {
  const candidates = collectModelLookupCandidates(modelName);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    const direct = STATIC_MODEL_METADATA[candidate];
    if (direct) return direct;
  }

  for (const candidate of candidates) {
    const bestKey = Object.keys(STATIC_MODEL_METADATA)
      .filter((key) => matchesModelFamily(candidate, key))
      .sort((left, right) => right.length - left.length)
      .at(0);
    if (bestKey) return STATIC_MODEL_METADATA[bestKey] ?? null;
  }

  return null;
}

function convertSourcePricingToEurPerToken(
  entry: StaticModelMetadataEntry | null,
): ModelCatalogMetadata['pricingEurPerToken'] {
  if (!entry?.pricing) return { input: null, output: null };
  return {
    input:
      entry.pricing.inputPerMillion /
      MODEL_METADATA_USD_TO_EUR.usdPerEur /
      1_000_000,
    output:
      entry.pricing.outputPerMillion /
      MODEL_METADATA_USD_TO_EUR.usdPerEur /
      1_000_000,
  };
}

function buildCapabilityFlags(
  capabilities: readonly ModelCapability[],
): ModelCapabilityFlags {
  return {
    vision: capabilities.includes('vision'),
    tools: capabilities.includes('tools'),
    jsonMode: capabilities.includes('jsonMode'),
    reasoning: capabilities.includes('reasoning'),
  };
}

export function resolveStaticModelCatalogMetadata(
  modelName: string,
): ModelCatalogMetadata {
  const entry = findStaticModelMetadataEntry(modelName);
  if (!entry) {
    return {
      dataVersion: MODEL_METADATA_DATA_VERSION,
      known: false,
      pricingEurPerToken: { input: null, output: null },
      contextWindow: null,
      maxTokens: null,
      capabilities: { ...EMPTY_CAPABILITIES },
      sources: [],
    };
  }

  return {
    dataVersion: MODEL_METADATA_DATA_VERSION,
    known: true,
    pricingEurPerToken: convertSourcePricingToEurPerToken(entry),
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens ?? null,
    capabilities: buildCapabilityFlags(entry.capabilities),
    sources: uniqueStrings([
      ...entry.sources,
      ...(entry.pricing ? [MODEL_METADATA_USD_TO_EUR.source] : []),
    ]),
  };
}
