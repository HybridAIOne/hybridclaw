import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

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

async function loadA2AInstance(params: {
  home: string;
  instanceId: string;
  agentId: string;
}) {
  process.env.HYBRIDCLAW_DATA_DIR = params.home;
  process.env.HOME = params.home;
  process.env.HYBRIDCLAW_INSTANCE_ID = params.instanceId;
  vi.resetModules();

  const [
    { initDatabase },
    runtimeConfig,
    runtime,
    inbound,
    outbound,
    trust,
    pairing,
  ] = await Promise.all([
      import('../src/memory/db.ts'),
      import('../src/config/runtime-config.ts'),
      import('../src/a2a/runtime.ts'),
      import('../src/a2a/a2a-inbound.ts'),
      import('../src/a2a/a2a-outbound.ts'),
      import('../src/a2a/trust-ledger.ts'),
      import('../src/a2a/pairing.ts'),
    ]);

  initDatabase({ quiet: true });
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: params.agentId,
        canonicalId: `${params.agentId}@team@${params.instanceId}`,
        owner: 'team',
        role: 'lead',
        a2a: { exposure: 'trusted' },
      },
    ];
  });

  return {
    home: params.home,
    instanceId: params.instanceId,
    runtimeConfig,
    runtime,
    inbound,
    outbound,
    trust,
    pairing,
  };
}

function activateA2AInstance(
  instance: Pick<
    Awaited<ReturnType<typeof loadA2AInstance>>,
    'home' | 'instanceId'
  >,
): void {
  process.env.HYBRIDCLAW_DATA_DIR = instance.home;
  process.env.HOME = instance.home;
  process.env.HYBRIDCLAW_INSTANCE_ID = instance.instanceId;
}

function createA2AInstanceServer(
  instance: Awaited<ReturnType<typeof loadA2AInstance>>,
): http.Server {
  return http.createServer(async (request, response) => {
    activateA2AInstance(instance);
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url || '/', origin);
    if (
      url.pathname === '/.well-known/agent.json' &&
      request.method === 'GET'
    ) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(
          instance.trust.buildLocalA2AAgentCard(origin, {
            peerTrustLevel: 'trusted',
          }),
        ),
      );
      return;
    }
    if (url.pathname === '/a2a/pairing/requests') {
      await instance.pairing.handleA2APairingRequestInbound(
        request,
        response,
        url,
      );
      return;
    }
    if (url.pathname === '/a2a') {
      await instance.inbound.handleA2AJsonRpcInbound(request, response, url);
      return;
    }
    response.writeHead(404);
    response.end();
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
      sender_instance_id: 'local',
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
          url: `http://127.0.0.1:${port}/a2a`,
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
        decoded: expect.objectContaining({
          ...envelope,
          sender_agent_id: expect.stringMatching(/^main@local@inst-/),
          sender_instance_id: expect.stringMatching(/^inst-/),
        }),
      },
    ]);
  });

  test('routes remote sendMessage recipients through DNS discovery and HTTP delivery', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'instance-x';
    process.env.HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE = 'identity.test';

    const peerPublicKeyJwk = generateKeyPairSync('ed25519').publicKey.export({
      format: 'jwk',
    });
    const received: unknown[] = [];
    let saveDeliveredEnvelope: (
      decoded: ReturnType<typeof decodeA2AJsonRpcRequest>,
    ) => void = () => {
      throw new Error('store not initialized');
    };
    let listRecipientInbox: () => ReturnType<typeof decodeA2AJsonRpcRequest>[] =
      () => {
        throw new Error('store not initialized');
      };
    const server = http.createServer(async (request, response) => {
      if (request.url === '/.well-known/agent.json') {
        response.writeHead(200, {
          'content-type': 'application/json',
          etag: '"identity-card-v1"',
        });
        response.end(
          JSON.stringify({
            name: 'Stub Instance Y',
            url: `http://${request.headers.host}/a2a`,
            capabilities: {
              messageSend: true,
            },
            hybridclaw: {
              instanceId: 'instance-y',
              publicKeyJwk: peerPublicKeyJwk,
            },
          }),
        );
        return;
      }

      if (request.url === '/a2a' && request.method === 'POST') {
        const body = await readRequestBody(request);
        const decoded = decodeA2AJsonRpcRequest(body);
        received.push(decoded);
        saveDeliveredEnvelope(decoded);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', result: { ok: true } }));
        return;
      }

      response.writeHead(404);
      response.end();
    });
    const port = await listen(server);

    try {
      vi.doMock('node:dns/promises', () => ({
        resolveTxt: vi.fn(async () => [
          [
            JSON.stringify({
              canonicalId: 'stub-b@team@instance-y',
              url: `http://127.0.0.1:${port}`,
              publicKey: JSON.stringify(peerPublicKeyJwk),
            }),
          ],
        ]),
      }));

      const { initDatabase } = await import('../src/memory/db.ts');
      const runtimeConfig = await import('../src/config/runtime-config.ts');
      const runtime = await import('../src/a2a/runtime.ts');
      const a2a = await import('../src/a2a/a2a-outbound.ts');
      const store = await import('../src/a2a/store.ts');

      initDatabase({ quiet: true });
      runtimeConfig.updateRuntimeConfig((draft) => {
        draft.agents.list = [
          { id: 'main', owner: 'team', role: 'lead' },
          { id: 'stub-a', owner: 'team', role: 'sender' },
        ];
      });
      saveDeliveredEnvelope = (decoded) => {
        store.saveA2AEnvelope(decoded, {
          actor: 'stub-instance-y',
          route: 'test.a2a.remote',
          source: 'stub-peer',
        });
      };
      listRecipientInbox = () =>
        store.listA2AInboxEnvelopes('stub-b@team@instance-y');

      const confirmation = runtime.sendMessage({
        id: 'msg-cross-instance',
        sender_agent_id: 'stub-a',
        recipient_agent_id: 'stub-b@team@instance-y',
        thread_id: 'thread-cross-instance',
        intent: 'chat',
        content: 'Route this to instance Y.',
        created_at: '2026-05-01T10:00:00.000Z',
      });

      expect(confirmation).toMatchObject({
        delivered: 'pending',
        message_id: 'msg-cross-instance',
        thread_id: 'thread-cross-instance',
        recipient_agent_id: 'stub-b@team@instance-y',
      });
      expect(listRecipientInbox()).toEqual([]);

      await expect(a2a.processA2AOutbox()).resolves.toMatchObject({
        processed: 1,
        delivered: 1,
      });
    } finally {
      await closeServer(server);
    }

    expect(received).toEqual([
      expect.objectContaining({
        id: 'msg-cross-instance',
        sender_agent_id: 'stub-a@team@instance-x',
        sender_instance_id: 'instance-x',
        recipient_agent_id: 'stub-b@team@instance-y',
        thread_id: 'thread-cross-instance',
      }),
    ]);
    expect(listRecipientInbox()).toEqual([
      expect.objectContaining({
        id: 'msg-cross-instance',
        sender_agent_id: 'stub-a@team@instance-x',
        recipient_agent_id: 'stub-b@team@instance-y',
      }),
    ]);
  });

  test('routes local canonical recipients through deployment public URL and HTTP delivery', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-inst-local-'));
    let server: http.Server | null = null;

    try {
      const instance = await loadA2AInstance({
        home,
        instanceId: 'inst-local',
        agentId: 'main',
      });
      const delegationKey =
        instance.outbound.getOrCreateA2ADelegationTokenKeyPair({
          now: new Date('2030-01-01T00:00:00.000Z'),
        });
      instance.inbound.upsertA2ATrustedA2APeer({
        peerId: 'self',
        senderAgentId: 'main@team@inst-local',
        publicKeyPem: delegationKey.publicKeyPem,
      });

      server = createA2AInstanceServer(instance);
      const port = await listen(server);
      const url = `http://127.0.0.1:${port}`;

      activateA2AInstance(instance);
      instance.runtimeConfig.updateRuntimeConfig((draft) => {
        draft.deployment.mode = 'local';
        draft.deployment.public_url = url;
        draft.deployment.tunnel.provider = 'manual';
      });

      instance.runtime.sendMessage(
        {
          id: 'msg-local-via-public-url',
          sender_agent_id: 'main@team@inst-local',
          recipient_agent_id: 'main@team@inst-local',
          sender_instance_id: 'inst-local',
          thread_id: 'thread-local-public-url',
          intent: 'chat',
          content: 'Loop through the public deployment URL.',
          created_at: '2026-05-01T10:00:00.000Z',
        },
        {
          peerDescriptor: {
            transport: 'a2a',
            canonicalId: 'main@team@inst-local',
          },
        },
      );

      await expect(instance.outbound.processA2AOutbox()).resolves.toMatchObject(
        { processed: 1, delivered: 1 },
      );

      expect(instance.runtime.inbox('main')).toMatchObject([
        {
          id: 'msg-local-via-public-url',
          sender_agent_id: 'main@team@inst-local',
          recipient_agent_id: 'main@team@inst-local',
        },
      ]);
      expect(
        instance.outbound.listA2AOutboxItems({ status: 'delivered' }),
      ).toEqual([
        expect.objectContaining({
          status: 'delivered',
          agentCardUrl: `${url}/.well-known/agent.json`,
          identityResolution: expect.objectContaining({
            status: 'resolved',
            canonicalId: 'main@team@inst-local',
            url,
          }),
        }),
      ]);
    } finally {
      if (server) await closeServer(server);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('instance A sends to instance B through identity resolution and B replies', async () => {
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-inst-a-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-inst-b-'));
    let serverA: http.Server | null = null;
    let serverB: http.Server | null = null;

    try {
      const instanceA = await loadA2AInstance({
        home: homeA,
        instanceId: 'inst-a',
        agentId: 'main',
      });

      const instanceB = await loadA2AInstance({
        home: homeB,
        instanceId: 'inst-b',
        agentId: 'remote',
      });

      serverA = createA2AInstanceServer(instanceA);
      serverB = createA2AInstanceServer(instanceB);
      const [portA, portB] = await Promise.all([
        listen(serverA),
        listen(serverB),
      ]);
      const urlA = `http://127.0.0.1:${portA}`;
      const urlB = `http://127.0.0.1:${portB}`;
      const fetchFromA: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        activateA2AInstance(instanceA);
        return response;
      };

      activateA2AInstance(instanceA);
      await instanceA.pairing.startA2APairing({
        peerUrl: urlB,
        localBaseUrl: urlA,
        actor: 'operator-a',
        fetchImpl: fetchFromA,
        now: new Date('2030-01-01T00:00:00.000Z'),
      });
      activateA2AInstance(instanceB);
      const [pairingRequest] =
        instanceB.pairing.listIncomingA2APairingRequests();
      expect(pairingRequest).toBeDefined();
      if (!pairingRequest) throw new Error('expected incoming pairing request');
      expect(pairingRequest).toMatchObject({
        status: 'pending',
        peerId: 'inst-a',
      });
      instanceB.pairing.approveIncomingA2APairingRequest({
        requestId: pairingRequest.requestId,
        actor: 'operator-b',
        now: new Date('2030-01-01T00:01:00.000Z'),
      });

      activateA2AInstance(instanceA);
      instanceA.runtime.sendMessage(
        {
          id: 'msg-a-to-b',
          sender_agent_id: 'main@team@inst-a',
          recipient_agent_id: 'remote@team@inst-b',
          sender_instance_id: 'inst-a',
          thread_id: 'thread-cross-instance-reply',
          intent: 'chat',
          content: 'Hello from A.',
          created_at: '2026-05-01T10:00:00.000Z',
        },
        {
          peerDescriptor: {
            transport: 'a2a',
            canonicalId: 'remote@team@inst-b',
          },
        },
      );

      activateA2AInstance(instanceA);
      await expect(
        instanceA.outbound.processA2AOutbox(),
      ).resolves.toMatchObject({ processed: 1, delivered: 1 });
      activateA2AInstance(instanceB);
      expect(instanceB.runtime.inbox('remote')).toMatchObject([
        {
          id: 'msg-a-to-b',
          sender_agent_id: 'main@team@inst-a',
          recipient_agent_id: 'remote@team@inst-b',
        },
      ]);

      activateA2AInstance(instanceB);
      instanceB.runtime.sendMessage(
        {
          id: 'msg-b-to-a',
          sender_agent_id: 'remote@team@inst-b',
          recipient_agent_id: 'main@team@inst-a',
          sender_instance_id: 'inst-b',
          thread_id: 'thread-cross-instance-reply',
          parent_message_id: 'msg-a-to-b',
          intent: 'chat',
          content: 'Reply from B.',
          created_at: '2026-05-01T10:01:00.000Z',
        },
        {
          peerDescriptor: {
            transport: 'a2a',
            canonicalId: 'main@team@inst-a',
          },
        },
      );

      await expect(
        instanceB.outbound.processA2AOutbox(),
      ).resolves.toMatchObject({ processed: 1, delivered: 1 });
      activateA2AInstance(instanceA);
      expect(instanceA.runtime.inbox('main')).toMatchObject([
        {
          id: 'msg-b-to-a',
          sender_agent_id: 'remote@team@inst-b',
          recipient_agent_id: 'main@team@inst-a',
          parent_message_id: 'msg-a-to-b',
        },
      ]);
    } finally {
      if (serverA) await closeServer(serverA);
      if (serverB) await closeServer(serverB);
      fs.rmSync(homeA, { recursive: true, force: true });
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });
});
