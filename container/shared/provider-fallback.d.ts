export type FallbackReason = 'auth' | 'rate_limit' | 'server_error' | 'other';

export function classifyProviderError(err: unknown): FallbackReason;
export function shouldFallbackProviderError(err: unknown): boolean;
