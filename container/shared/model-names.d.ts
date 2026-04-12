export declare const HYBRIDAI_MODEL_PREFIX: 'hybridai/';
export declare const NON_HYBRID_PROVIDER_PREFIXES: readonly string[];

export declare function hasKnownNonHybridProviderPrefix(model: string): boolean;

export declare function hasDisplayOnlyHybridAIPrefix(model: string): boolean;

export declare function stripProviderPrefix(
  model: string,
  prefix: string,
): string;

export declare function stripHybridAIModelPrefix(model: string): string;

export declare function formatHybridAIModelForCatalog(model: string): string;

export declare function normalizeHybridAIModelForRuntime(model: string): string;
