export type FallbackReason = 'auth' | 'rate_limit' | 'other';

export function classifyProviderError(err: unknown): FallbackReason;
export function shouldFallbackProviderError(err: unknown): boolean;
