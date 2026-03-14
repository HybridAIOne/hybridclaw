import type { AddressInfo } from 'node:net';

import { afterEach, expect, test } from 'vitest';
import { WebSocketServer } from 'ws';

import { CdpTransport } from '../container/src/browser/cdp-transport.js';

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function createServer(): Promise<WebSocketServer> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
  });
  servers.push(server);
  if (server.address()) return server;
  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });
  return server;
}

test('CDP transport sends commands and receives session-scoped events', async () => {
  const server = await createServer();
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as {
        id: number;
        method: string;
      };
      socket.send(
        JSON.stringify({
          id: message.id,
          result: { product: 'Chrome/122.0.0.0' },
        }),
      );
      socket.send(
        JSON.stringify({
          method: 'Runtime.consoleAPICalled',
          sessionId: 'page-1',
          params: {
            text: 'ready',
          },
        }),
      );
    });
  });

  const address = server.address() as AddressInfo;
  const transport = new CdpTransport(`ws://127.0.0.1:${address.port}`);
  const eventPromise = transport.waitForEvent(
    'Runtime.consoleAPICalled',
    (event) =>
      (event.params as { text?: string } | undefined)?.text === 'ready',
    {
      sessionId: 'page-1',
      timeoutMs: 2_000,
    },
  );

  await expect(transport.send('Browser.getVersion')).resolves.toEqual({
    product: 'Chrome/122.0.0.0',
  });
  await expect(eventPromise).resolves.toMatchObject({
    method: 'Runtime.consoleAPICalled',
    sessionId: 'page-1',
  });
  await transport.close();
});

test('CDP transport times out unanswered commands', async () => {
  const server = await createServer();
  server.on('connection', (socket) => {
    socket.on('message', () => {
      // Intentionally do not answer.
    });
  });

  const address = server.address() as AddressInfo;
  const transport = new CdpTransport(`ws://127.0.0.1:${address.port}`, {
    timeoutMs: 75,
  });

  await expect(transport.send('Page.navigate')).rejects.toThrow(
    /Timed out waiting for CDP response/,
  );
  await transport.close();
});
