import { describe, expect, test } from 'vitest';

import {
  classifyA2AHttpStatus,
  shouldRetryA2AJsonRpcErrorCode,
} from '../src/a2a/a2a-retry-policy.ts';

describe('A2A retry policy', () => {
  test('classifies HTTP status codes for outbox delivery', () => {
    expect(classifyA2AHttpStatus(200)).toBeNull();
    expect(classifyA2AHttpStatus(202)).toBeNull();
    expect(classifyA2AHttpStatus(400)).toBe('fail-fast');
    expect(classifyA2AHttpStatus(429)).toBe('fail-fast');
    expect(classifyA2AHttpStatus(500)).toBe('retry');
    expect(classifyA2AHttpStatus(503)).toBe('retry');
  });

  test('classifies invalid HTTP status values as fail-fast', () => {
    expect(classifyA2AHttpStatus(Number.NaN)).toBe('fail-fast');
    expect(classifyA2AHttpStatus(12.5)).toBe('fail-fast');
  });

  test('retries only JSON-RPC internal and server-defined errors', () => {
    expect(shouldRetryA2AJsonRpcErrorCode(-32603)).toBe(true);
    expect(shouldRetryA2AJsonRpcErrorCode(-32000)).toBe(true);
    expect(shouldRetryA2AJsonRpcErrorCode(-32099)).toBe(true);
    expect(shouldRetryA2AJsonRpcErrorCode(-32602)).toBe(false);
    expect(shouldRetryA2AJsonRpcErrorCode(-32700)).toBe(false);
    expect(shouldRetryA2AJsonRpcErrorCode(1000)).toBe(false);
  });
});
