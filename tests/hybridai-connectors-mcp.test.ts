import { describe, expect, test, vi } from 'vitest';

async function importHelper() {
  vi.resetModules();
  vi.doMock('../src/config/config.js', () => ({
    HYBRIDAI_API_KEY: '',
    HYBRIDAI_BASE_URL: 'https://hybridai.one',
  }));
  return import('../src/mcp/hybridai-connectors.ts');
}

describe('HybridAI connectors MCP auto registration', () => {
  test('does not register without a HybridAI API key', async () => {
    const { withAutoHybridAIConnectorsMcpServer } = await importHelper();
    const servers = {};

    expect(withAutoHybridAIConnectorsMcpServer(servers)).toBe(servers);
  });

  test('registers the HybridAI connectors gateway with the bearer token', async () => {
    const { withAutoHybridAIConnectorsMcpServer } = await importHelper();

    expect(
      withAutoHybridAIConnectorsMcpServer(
        {},
        { apiKey: 'hai-test-secret', baseUrl: 'http://localhost:5000' },
      ),
    ).toEqual({
      hybridai: {
        transport: 'http',
        url: 'http://localhost:5000/api/v1/connectors/mcp',
        headers: {
          Authorization: 'Bearer hai-test-secret',
        },
        enabled: true,
      },
    });
  });

  test('respects an explicitly disabled HybridAI MCP server', async () => {
    const { withAutoHybridAIConnectorsMcpServer } = await importHelper();
    const servers = {
      hybridai: {
        transport: 'http' as const,
        url: 'https://hybridai.one/api/v1/connectors/mcp',
        enabled: false,
      },
    };

    expect(
      withAutoHybridAIConnectorsMcpServer(servers, {
        apiKey: 'hai-test-secret',
      }),
    ).toBe(servers);
  });

  test('preserves explicit URL and non-auth headers while refreshing authorization', async () => {
    const { withAutoHybridAIConnectorsMcpServer } = await importHelper();

    expect(
      withAutoHybridAIConnectorsMcpServer(
        {
          hybridai: {
            transport: 'http',
            url: 'https://staging.hybridai.one/api/v1/connectors/mcp',
            headers: {
              Authorization: 'Bearer old-token',
              'X-Trace': 'test',
            },
          },
        },
        { apiKey: 'hai-new-secret', baseUrl: 'https://hybridai.one' },
      ).hybridai,
    ).toEqual({
      transport: 'http',
      url: 'https://staging.hybridai.one/api/v1/connectors/mcp',
      headers: {
        Authorization: 'Bearer hai-new-secret',
        'X-Trace': 'test',
      },
      enabled: true,
    });
  });

  test('can remap local gateway URLs for Docker runtime', async () => {
    const { withAutoHybridAIConnectorsMcpServer } = await importHelper();

    expect(
      withAutoHybridAIConnectorsMcpServer(
        {},
        {
          apiKey: 'hai-test-secret',
          baseUrl: 'http://localhost:5000',
          mapUrl: (url) => url.replace('//localhost:', '//host.docker.internal:'),
        },
      ).hybridai?.url,
    ).toBe('http://host.docker.internal:5000/api/v1/connectors/mcp');
  });
});
