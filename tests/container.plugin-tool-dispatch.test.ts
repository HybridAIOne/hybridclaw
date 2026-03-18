import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container plugin tool dispatch', () => {
  afterEach(async () => {
    const { setGatewayContext, setPluginTools } = await import(
      '../container/src/tools.js'
    );
    setGatewayContext(undefined, undefined, undefined, undefined);
    setPluginTools(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('forwards registered plugin tools to the gateway plugin endpoint', async () => {
    const {
      executeTool,
      setGatewayContext,
      setPluginTools,
      getPluginToolDefinitions,
    } = await import('../container/src/tools.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true, result: 'plugin-result' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    setGatewayContext('http://127.0.0.1:9000', 'token-123', 'web', []);
    setPluginTools([
      {
        name: 'honcho_query',
        description: 'Query Honcho memory',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string' },
          },
          required: ['question'],
        },
      },
    ]);

    expect(getPluginToolDefinitions()).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'honcho_query' }),
      }),
    ]);

    const result = await executeTool(
      'honcho_query',
      JSON.stringify({ question: 'hello?' }),
    );

    expect(result).toBe('plugin-result');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9000/api/plugin/tool',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          toolName: 'honcho_query',
          args: { question: 'hello?' },
          sessionId: '',
          channelId: 'web',
        }),
      }),
    );
  });
});
