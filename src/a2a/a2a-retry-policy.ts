export type A2ADeliveryRetryDecision = 'proceed' | 'retry' | 'fail-fast';

export function classifyA2AHttpStatus(
  statusCode: number,
): A2ADeliveryRetryDecision {
  if (!Number.isSafeInteger(statusCode)) return 'fail-fast';
  if (statusCode === 429) return 'retry';
  if (statusCode >= 500) return 'retry';
  if (statusCode >= 400) return 'fail-fast';
  return 'proceed';
}

export function shouldRetryA2AJsonRpcErrorCode(code: number): boolean {
  if (!Number.isSafeInteger(code)) return false;
  return code === -32603 || (code <= -32000 && code >= -32099);
}
