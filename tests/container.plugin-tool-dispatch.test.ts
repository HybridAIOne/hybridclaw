import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
      setMediaContext,
    } = await import('../container/src/tools.js');
    const requests: Array<{
      url: string | undefined;
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];
    // A real server: plugin tool calls bypass fetch so long tools outlive
    // fetch's 300s header timeout.
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        requests.push({ url: req.url, headers: req.headers, body });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: 'plugin-result' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const media = [
      {
        path: '/discord-media-cache/voice.ogg',
        url: 'https://cdn.discordapp.com/voice.ogg',
        originalUrl: 'https://cdn.discordapp.com/voice.ogg',
        mimeType: 'audio/ogg',
        sizeBytes: 12,
        filename: 'voice.ogg',
      },
    ];
    setMediaContext(media);

    setGatewayContext(`http://127.0.0.1:${port}`, 'token-123', 'web', []);
    setPluginTools([
      {
        name: 'memory_lookup',
        description: 'Query plugin memory',
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
        function: expect.objectContaining({ name: 'memory_lookup' }),
      }),
    ]);

    const result = await executeTool(
      'memory_lookup',
      JSON.stringify({ question: 'hello?' }),
    );

    await new Promise((resolve) => server.close(resolve));
    setMediaContext(undefined);

    expect(result).toBe('plugin-result');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('/api/plugin/tool');
    expect(requests[0]?.headers).toMatchObject({
      authorization: 'Bearer token-123',
      'content-type': 'application/json',
    });
    expect(JSON.parse(requests[0]?.body || '{}')).toEqual({
      toolName: 'memory_lookup',
      args: { question: 'hello?' },
      sessionId: '',
      channelId: 'web',
      media,
    });
  });
});
