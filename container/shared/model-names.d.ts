export declare const HYBRIDAI_MODEL_PREFIX: 'hybridai/';
export declare const NON_HYBRID_PROVIDER_PREFIXES: readonly string[];

export declare function hasKnownNonHybridProviderPrefix(model: string): boolean;

export declare function hasDisplayOnlyHybridAIPrefix(model: string): boolean;

export declare function normalizeHybridAIModelForRuntime(model: string): string;
