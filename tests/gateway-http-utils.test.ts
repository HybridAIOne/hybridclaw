import type { ServerResponse } from 'node:http';
import { describe, expect, test, vi } from 'vitest';

import { sendJson } from '../src/gateway/gateway-http-utils.js';

function createResponse() {
  const writeHead = vi.fn();
  const end = vi.fn();
  const res = {
    writeHead,
    end,
  } as unknown as ServerResponse;
  return { res, writeHead, end };
}

describe('sendJson', () => {
  test('does not serialize Error stack traces', () => {
    const { res, end } = createResponse();
    const error = new Error('boom');

    sendJson(res, 500, { error });

    const body = String(end.mock.calls[0]?.[0] || '');
    expect(body).toContain('"name": "Error"');
    expect(body).toContain('"message": "boom"');
    expect(body).not.toContain('stack');
  });

  test('drops stack-like fields from response payloads', () => {
    const { res, end } = createResponse();

    sendJson(res, 500, {
      error: 'failed',
      stack: 'Error: failed\n at secret',
      stackTrace: 'Error: failed',
      nested: {
        stack_trace: 'Error: failed',
        reason: 'safe',
      },
    });

    const body = String(end.mock.calls[0]?.[0] || '');
    expect(body).toContain('"error": "failed"');
    expect(body).toContain('"reason": "safe"');
    expect(body).not.toContain('stack');
    expect(body).not.toContain('secret');
  });
});
