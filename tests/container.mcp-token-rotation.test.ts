import http from 'node:http';
import { afterEach, expect, test } from 'vitest';

import { McpClientManager } from '../container/src/mcp/client-manager.js';
import type { McpServerConfig } from '../container/src/mcp/types.js';

interface SeenRequest {
  method: string;
  authorization: string | undefined;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Streamable-HTTP MCP endpoint with one tool that records each request. */
async function startMcpServer(): Promise<{ url: string; seen: SeenRequest[] }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer(async (req, res) => {
    // No standalone SSE stream: the client carries on without one.
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const message = JSON.parse(text) as { id?: number; method: string };
    seen.push({
      method: message.method,
      authorization: req.headers.authorization,
    });
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'docs', version: '1.0.0' },
          }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'pong' }] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }
  return { url: `http://127.0.0.1:${address.port}/mcp`, seen };
}

function startManager(): McpClientManager {
  const manager = new McpClientManager();
  cleanups.push(() => manager.shutdown());
  return manager;
}

function withToken(url: string, token: string): McpServerConfig {
  return { transport: 'http', url, headers: { Authorization: token } };
}

test('a rotated token goes out on the live connection', async () => {
  const mcp = await startMcpServer();
  const manager = startManager();
  await manager.replaceClient('docs', withToken(mcp.url, 'Bearer one'));

  await manager.rotateAuthorization('docs', withToken(mcp.url, 'Bearer two'));
  await expect(manager.callTool('docs__ping', {})).resolves.toBe('pong');

  expect(mcp.seen.filter((seen) => seen.method === 'initialize')).toEqual([
    { method: 'initialize', authorization: 'Bearer one' },
  ]);
  expect(mcp.seen.at(-1)).toEqual({
    method: 'tools/call',
    authorization: 'Bearer two',
  });
});

test('a rotated token connects a server that has no live connection', async () => {
  const mcp = await startMcpServer();
  const manager = startManager();

  await manager.rotateAuthorization('docs', withToken(mcp.url, 'Bearer two'));

  expect(manager.isKnownTool('docs__ping')).toBe(true);
  expect(mcp.seen[0]).toEqual({
    method: 'initialize',
    authorization: 'Bearer two',
  });
});
