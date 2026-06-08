import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container http_request dispatch', () => {
  afterEach(async () => {
    const { setGatewayContext, setSessionContext } = await import(
      '../container/src/tools.js'
    );
    setGatewayContext(undefined, undefined, undefined, undefined);
    setSessionContext('');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('forwards http_request payloads to the gateway endpoint', async () => {
    const { executeTool, setGatewayContext, setSessionContext } = await import(
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
    setSessionContext('agent:main:channel:web:chat:dm:peer:test');

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
          sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        }),
      }),
    );
  });

  test('forwards env placeholders and self-signed TLS flags to the gateway endpoint', async () => {
    const { executeTool, setGatewayContext, setSessionContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: 200,
          body: '{"key":"test-application-key"}',
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);
    setSessionContext('agent:main:channel:web:chat:dm:peer:test');

    const result = await executeTool(
      'http_request',
      JSON.stringify({
        url: '<env:HUE_BRIDGE_HOST>/api/config/connections',
        method: 'POST',
        json: {
          devicetype: 'hybridclaw#lab',
        },
        secretHeaders: [
          {
            name: 'hue-application-key',
            secretName: 'HUE_APPLICATION_KEY',
            prefix: 'none',
          },
        ],
        replaceSecretPlaceholders: true,
        allowSelfSignedTls: true,
        skillName: 'hue',
      }),
    );

    expect(result).toContain('"ok": true');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/api/http/request',
      expect.objectContaining({
        body: JSON.stringify({
          url: '<env:HUE_BRIDGE_HOST>/api/config/connections',
          method: 'POST',
          json: {
            devicetype: 'hybridclaw#lab',
          },
          secretHeaders: [
            {
              name: 'hue-application-key',
              secretName: 'HUE_APPLICATION_KEY',
              prefix: 'none',
            },
          ],
          replaceSecretPlaceholders: true,
          allowSelfSignedTls: true,
          skillName: 'hue',
          sessionId: 'agent:main:channel:web:chat:dm:peer:test',
        }),
      }),
    );
  });

  test('http_request schema exposes scoped TLS controls', async () => {
    const { TOOL_DEFINITIONS } = await import('../container/src/tools.js');
    const httpRequest = TOOL_DEFINITIONS.find(
      (tool) => tool.function.name === 'http_request',
    );
    const properties = httpRequest?.function.parameters.properties;

    expect(properties).toMatchObject({
      allowSelfSignedTls: {
        type: 'boolean',
      },
      tlsCertificateSha256: {
        type: 'string',
      },
      tlsCertificateSha256SecretName: {
        type: 'string',
      },
    });
  });

  test('surfaces upstream JSON error details before headers for proxied failures', async () => {
    const { executeToolWithMetadata, setGatewayContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          url: 'https://analyticsdata.googleapis.com/v1beta/properties/537331984:runReport',
          headers: {
            'content-type': 'application/json; charset=UTF-8',
          },
          body: JSON.stringify({
            error: {
              code: 403,
              message:
                'Google Analytics Data API has not been used in project 54329896720 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'SERVICE_DISABLED',
                  domain: 'googleapis.com',
                  metadata: {
                    service: 'analyticsdata.googleapis.com',
                    activationUrl:
                      'https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=54329896720',
                  },
                },
              ],
            },
          }),
          json: {
            error: {
              code: 403,
              message:
                'Google Analytics Data API has not been used in project 54329896720 before or it is disabled.',
              status: 'PERMISSION_DENIED',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  reason: 'SERVICE_DISABLED',
                  domain: 'googleapis.com',
                  metadata: {
                    service: 'analyticsdata.googleapis.com',
                    activationUrl:
                      'https://console.developers.google.com/apis/api/analyticsdata.googleapis.com/overview?project=54329896720',
                  },
                },
              ],
            },
          },
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);

    const result = await executeToolWithMetadata(
      'http_request',
      JSON.stringify({
        url: 'https://analyticsdata.googleapis.com/v1beta/properties/537331984:runReport',
        method: 'POST',
        bearerSecretName: 'GOOGLE_WORKSPACE_CLI_TOKEN',
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('"reason": "SERVICE_DISABLED"');
    expect(result.output).toContain('Google Analytics Data API');
    expect(result.output).not.toContain('"headers"');
  });

  test('automatically adds gateway auth to proxied gateway requests', async () => {
    const { executeTool, setGatewayContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);

    await executeTool(
      'http_request',
      JSON.stringify({
        url: 'http://127.0.0.1:9000/api/http/request',
        method: 'POST',
        headers: {
          authorization: 'Bearer stale-token',
        },
        json: {
          url: 'https://googleads.googleapis.com/v20/customers:listAccessibleCustomers',
          method: 'GET',
        },
      }),
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { headers?: Record<string, string> };
    expect(body.headers).toEqual({
      Authorization: 'Bearer token-123',
    });
  });

  test('treats loopback and host.docker.internal as the same local gateway target', async () => {
    const { executeTool, setGatewayContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext(
      'http://host.docker.internal:9090',
      'token-123',
      'web',
      [],
    );

    await executeTool(
      'http_request',
      JSON.stringify({
        url: 'http://127.0.0.1:9090/api/http/request',
        method: 'POST',
        json: {
          url: 'https://example.com',
          method: 'GET',
        },
      }),
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { headers?: Record<string, string> };
    expect(body.headers).toEqual({
      Authorization: 'Bearer token-123',
    });
  });

  test('does not add gateway auth to non-gateway requests', async () => {
    const { executeTool, setGatewayContext } = await import(
      '../container/src/tools.js'
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, status: 200 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);

    await executeTool(
      'http_request',
      JSON.stringify({
        url: 'https://api.example.com/v1/things',
        method: 'GET',
      }),
    );

    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { headers?: Record<string, string> };
    expect(body.headers).toBeUndefined();
  });
});
