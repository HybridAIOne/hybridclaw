import type { ServerResponse } from 'node:http';

import { expect, test } from 'vitest';

import { sendWebhookJson } from '../src/channels/webhook-http.js';

function makeResponse(): ServerResponse & {
  body: string;
  headers: Record<string, string>;
  writableEnded: boolean;
  headersSent: boolean;
} {
  const headers: Record<string, string> = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: '',
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        response.body += Buffer.isBuffer(chunk)
          ? chunk.toString('utf8')
          : String(chunk);
      }
      response.writableEnded = true;
      response.headersSent = true;
    },
  };
  return response as unknown as ServerResponse & {
    body: string;
    headers: Record<string, string>;
    writableEnded: boolean;
    headersSent: boolean;
  };
}

test('sendWebhookJson sends a JSON body when no response has started', () => {
  const res = makeResponse();

  sendWebhookJson(res, 202, { ok: true });

  expect(res.statusCode).toBe(202);
  expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(res.body).toBe(JSON.stringify({ ok: true }));
  expect(res.writableEnded).toBe(true);
});

test('sendWebhookJson does not append a fallback body after the response has started', () => {
  const res = makeResponse();
  res.headersSent = true;
  res.body = '{"partial":true';

  sendWebhookJson(res, 500, { error: 'Internal server error' });

  expect(res.body).toBe('{"partial":true');
  expect(res.writableEnded).toBe(true);
});
