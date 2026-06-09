import { createRequire } from 'node:module';

import { expect, test, vi } from 'vitest';

const require = createRequire(import.meta.url);
const gatewayHttp = require('../skills/shared/gateway-http.cjs');

test('shared gateway helper resolves gateway URL and token consistently', () => {
  expect(
    gatewayHttp.resolveGatewayUrl(undefined, {
      env: { HYBRIDCLAW_GATEWAY_URL: 'http://127.0.0.1:9090///' },
    }),
  ).toBe('http://127.0.0.1:9090');
  expect(
    gatewayHttp.resolveGatewayUrl('https://gateway.example.com///', {
      env: {},
    }),
  ).toBe('https://gateway.example.com');
  expect(() =>
    gatewayHttp.resolveGatewayUrl('ftp://gateway.example.com', { env: {} }),
  ).toThrow('--gateway-url must use http or https.');

  expect(
    gatewayHttp.resolveGatewayToken('', {
      env: {
        GATEWAY_API_TOKEN: 'fallback-token',
        HYBRIDCLAW_GATEWAY_TOKEN: 'hybridclaw-token',
      },
    }),
  ).toBe('hybridclaw-token');
  expect(
    gatewayHttp.resolveGatewayToken('raw-token', {
      env: { HYBRIDCLAW_GATEWAY_TOKEN: 'hybridclaw-token' },
    }),
  ).toBe('raw-token');
  expect(
    gatewayHttp.resolveGatewayToken('', {
      env: { WEB_API_TOKEN: 'web-token' },
    }),
  ).toBe('');
  expect(
    gatewayHttp.resolveGatewayToken('', {
      env: { WEB_API_TOKEN: 'web-token' },
      gatewayTokenEnvNames: ['WEB_API_TOKEN'],
    }),
  ).toBe('web-token');
});

test('shared gateway helper posts through the gateway and normalizes envelopes', async () => {
  const httpRequest = {
    method: 'GET',
    timeoutMs: 10_000,
    url: 'https://api.example.com/v1/items',
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
        body: '{"items":[{"id":"item_1"}]}',
      }),
  }));

  const result = await gatewayHttp.executeGatewayRequest(httpRequest, {
    command: 'live-result',
    fetch: fetchMock,
    gatewayToken: 'gateway-token',
    gatewayUrl: 'http://127.0.0.1:9090',
    serviceName: 'Example',
  });

  expect(result).toMatchObject({
    bodyJson: { items: [{ id: 'item_1' }] },
    command: 'live-result',
    ok: true,
    status: 200,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'http://127.0.0.1:9090/api/http/request',
    expect.objectContaining({
      body: JSON.stringify(httpRequest),
      headers: {
        Authorization: 'Bearer gateway-token',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }),
  );
});

test('shared gateway helper can return raw gateway envelopes', async () => {
  const envelope = {
    ok: true,
    status: 200,
    headers: {},
    body: '{"raw":true}',
  };
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(envelope),
  }));

  await expect(
    gatewayHttp.executeGatewayRequest(
      { method: 'GET', url: 'https://api.example.com/v1/items' },
      {
        fetch: fetchMock,
        gatewayUrl: 'http://127.0.0.1:9090',
        normalize: false,
      },
    ),
  ).resolves.toEqual(envelope);
});

test('shared gateway helper formats gateway policy and truncation errors', async () => {
  const policyFetch = vi.fn(async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () =>
      JSON.stringify({
        error:
          'HTTP request blocked: host is not allowlisted by workspace network policy.',
      }),
  }));
  const truncatedFetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () =>
      JSON.stringify({
        ok: true,
        status: 200,
        body: '{"items":[',
        bodyTruncated: true,
        maxResponseBytes: 128,
      }),
  }));

  await expect(
    gatewayHttp.executeGatewayRequest(
      { method: 'GET', url: 'https://api.example.com/v1/items' },
      {
        fetch: policyFetch,
        gatewayUrl: 'http://127.0.0.1:9090',
        serviceName: 'Example',
      },
    ),
  ).rejects.toThrow('workspace network policy denied');
  await expect(
    gatewayHttp.executeGatewayRequest(
      { method: 'GET', url: 'https://api.example.com/v1/items' },
      {
        fetch: truncatedFetch,
        gatewayUrl: 'http://127.0.0.1:9090',
        serviceName: 'Example',
      },
    ),
  ).rejects.toThrow('Example response was truncated by the gateway at 128 bytes');
});
