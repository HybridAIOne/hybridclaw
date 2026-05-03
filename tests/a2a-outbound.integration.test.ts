import http from 'node:http';

import { describe, expect, test } from 'vitest';

import { decodeA2AJsonRpcRequest } from '../src/a2a/a2a-json-rpc.ts';
import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-outbound-int-');

function readRequestBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('A2A peer did not bind to a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('A2A outbound integration', () => {
  test('stub peer accepts message/send and decoder round-trips the canonical envelope', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    const envelope = {
      id: 'msg-int-a2a',
      sender_agent_id: 'main',
      recipient_agent_id: 'remote@team@peer-instance',
      thread_id: 'thread-int-a2a',
      intent: 'chat',
      content: 'Peer should decode this.',
      created_at: '2026-05-01T10:00:00.000Z',
    };
    const received: unknown[] = [];
    const server = http.createServer(async (request, response) => {
      if (request.url === '/.well-known/agent.json') {
        response.writeHead(200, {
          'content-type': 'application/json',
          etag: '"int-card-v1"',
        });
        response.end(
          JSON.stringify({
            name: 'Stub A2A Peer',
            url: `http://${request.headers.host}/a2a`,
            capabilities: [],
          }),
        );
        return;
      }

      if (request.url === '/a2a' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const decoded = decodeA2AJsonRpcRequest(body);
        received.push({
          request: JSON.parse(body),
          decoded,
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', result: { ok: true } }));
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);

    try {
      runtime.sendMessage(envelope, {
        peerDescriptor: {
          transport: 'a2a',
          agentCardUrl: `http://127.0.0.1:${port}/.well-known/agent.json`,
        },
        transportRegistry: registry,
      });

      await expect(a2a.processA2AOutbox()).resolves.toMatchObject({
        processed: 1,
        delivered: 1,
      });
    } finally {
      await closeServer(server);
    }

    expect(received).toEqual([
      {
        request: expect.objectContaining({
          jsonrpc: '2.0',
          method: 'message/send',
        }),
        decoded: envelope,
      },
    ]);
  });
});
