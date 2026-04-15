export type GatewayErrorClass = 'transient' | 'permanent' | 'unknown';

const TRANSIENT_GATEWAY_ERROR_PATTERNS: RegExp[] = [
  /econnreset/i,
  /etimedout/i,
  /429/i,
  /5\d\d/i,
  /socket/i,
  /fetch failed/i,
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /connection reset/i,
  /network/i,
  /temporar/i,
  /try again/i,
  /rate limit/i,
  /unavailable/i,
  /abort/i,
  /interrupt/i,
  /killed/i,
  /terminated/i,
];

const PERMANENT_GATEWAY_ERROR_PATTERNS: RegExp[] = [
  /forbidden/i,
  /permission denied/i,
  /unauthorized/i,
  /not found/i,
  /invalid api key/i,
  /blocked by security hook/i,
];

export function classifyGatewayError(errorText: string): GatewayErrorClass {
  if (
    PERMANENT_GATEWAY_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))
  ) {
    return 'permanent';
  }
  if (
    TRANSIENT_GATEWAY_ERROR_PATTERNS.some((pattern) => pattern.test(errorText))
  ) {
    return 'transient';
  }
  return 'unknown';
}
