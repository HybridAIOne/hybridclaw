import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container http_request dispatch', () => {
  afterEach(async () => {
    const { setGatewayContext } = await import('../container/src/tools.js');
    setGatewayContext(undefined, undefined, undefined, undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('forwards http_request payloads to the gateway endpoint', async () => {
    const { executeTool, setGatewayContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: 200,
          body: '{"message":"hello"}',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);

    const result = await executeTool(
      'http_request',
      JSON.stringify({
        url: 'https://hybridai.one/v1/completions',
        method: 'POST',
        json: {
          prompt: 'Hallo Welt!',
        },
        bearerSecretName: 'HYBRIDAI_API_KEY',
      }),
    );

    expect(result).toContain('"ok": true');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/api/http/request',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          url: 'https://hybridai.one/v1/completions',
          method: 'POST',
          json: {
            prompt: 'Hallo Welt!',
          },
          bearerSecretName: 'HYBRIDAI_API_KEY',
        }),
      }),
    );
  });
});
