export type A2ADeliveryRetryDecision = 'retry' | 'fail-fast';

export function classifyA2AHttpStatus(
  statusCode: number,
): A2ADeliveryRetryDecision | null {
  if (!Number.isSafeInteger(statusCode)) return 'fail-fast';
  if (statusCode >= 500) return 'retry';
  if (statusCode >= 400) return 'fail-fast';
  return null;
}

export function shouldRetryA2AJsonRpcErrorCode(code: number): boolean {
  return code === -32603 || (code <= -32000 && code >= -32099);
}
