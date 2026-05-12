import http from 'node:http';

import { describe, expect, test } from 'vitest';

import {
  sampleA2AWebhookEnvelope,
  setupA2AWebhookTestEnv,
} from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-webhook-int-');

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
        reject(new Error('receiver did not bind to a TCP port'));
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

describe('A2A webhook outbound integration', () => {
  test('stub receiver rejects old signatures after rotation and accepts new envelopes', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({ autoProcess: false }),
    );
    let receiverSecret = 'old-secret';
    const received: Array<{
      id: string;
      body: string;
      signature: string;
      accepted: boolean;
    }> = [];
    const server = http.createServer(async (request, response) => {
      const body = await readRequestBody(request);
      const signature = String(
        request.headers[webhook.WEBHOOK_SIGNATURE_HEADER.toLowerCase()] || '',
      );
      const accepted = webhook.verifyWebhookSignature({
        header: signature,
        body,
        secret: receiverSecret,
      });
      const parsed = JSON.parse(body) as { id?: string };
      received.push({
        id: parsed.id || '',
        body,
        signature,
        accepted,
      });
      response.writeHead(accepted ? 202 : 401);
      response.end();
    });
    const port = await listen(server);
    const peerDescriptor = {
      transport: 'webhook',
      url: `http://127.0.0.1:${port}/a2a`,
      secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
    } as const;

    try {
      secrets.saveNamedRuntimeSecrets({ A2A_WEBHOOK_SECRET: 'old-secret' });
      runtime.sendMessage(sampleA2AWebhookEnvelope('msg-old-secret'), {
        peerDescriptor,
        transportRegistry: registry,
      });

      await expect(webhook.processWebhookOutbox()).resolves.toMatchObject({
        processed: 1,
        delivered: 1,
      });
      expect(received[0]).toMatchObject({
        id: 'msg-old-secret',
        accepted: true,
      });

      receiverSecret = 'new-secret';
      secrets.saveNamedRuntimeSecrets({ A2A_WEBHOOK_SECRET: 'new-secret' });

      const oldReplay = await fetch(peerDescriptor.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [webhook.WEBHOOK_SIGNATURE_HEADER]: received[0]?.signature || '',
        },
        body: received[0]?.body || '',
      });
      expect(oldReplay.status).toBe(401);
      expect(received[1]).toMatchObject({
        id: 'msg-old-secret',
        accepted: false,
      });

      runtime.sendMessage(sampleA2AWebhookEnvelope('msg-new-secret'), {
        peerDescriptor,
        transportRegistry: registry,
      });

      await expect(webhook.processWebhookOutbox()).resolves.toMatchObject({
        processed: 1,
        delivered: 1,
      });
      expect(received[2]).toMatchObject({
        id: 'msg-new-secret',
        accepted: true,
      });
    } finally {
      await closeServer(server);
    }
  });
});
