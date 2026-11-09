export declare const ANTHROPIC_MODEL_PREFIX: 'anthropic/';
export declare const ANTHROPIC_DEFAULT_BASE_URL: 'https://api.anthropic.com/v1';

export declare function normalizeAnthropicModelName(modelId: string): string;

export declare function stripAnthropicModelPrefix(modelId: string): string;

export declare function normalizeAnthropicBaseUrl(rawBaseUrl: string): string;

export declare function isAnthropicOAuthToken(value: string): boolean;
