import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

import { encodeA2AJsonRpcRequest } from '../src/a2a/a2a-json-rpc.ts';
import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-inbound-');

function inboundEnvelope(id: string) {
  return {
    id,
    sender_agent_id: 'remote@team@peer-instance',
    recipient_agent_id: 'main',
    thread_id: 'thread-a2a-inbound',
    intent: 'chat' as const,
    content: `Inbound A2A payload ${id}`,
    created_at: '2026-05-01T10:00:00.000Z',
  };
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

async function loadInboundTestModules() {
  const [
    { initDatabase, getRecentStructuredAuditForSession },
    runtimeConfig,
    runtime,
    inbound,
    outbound,
  ] = await Promise.all([
    import('../src/memory/db.ts'),
    import('../src/config/runtime-config.ts'),
    import('../src/a2a/runtime.ts'),
    import('../src/a2a/a2a-inbound.ts'),
    import('../src/a2a/a2a-outbound.ts'),
  ]);

  initDatabase({ quiet: true });
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.agents.list = [{ id: 'main', owner: 'team', role: 'lead' }];
  });

  return {
    getRecentStructuredAuditForSession,
    runtime,
    inbound,
    outbound,
  };
}

async function loadHttpEnvelopeInstance(params: {
  home: string;
  instanceId: string;
  agentId: string;
}) {
  process.env.HYBRIDCLAW_DATA_DIR = params.home;
  process.env.HOME = params.home;
  process.env.HYBRIDCLAW_INSTANCE_ID = params.instanceId;
  vi.resetModules();
  const [
    { initDatabase, getRecentStructuredAuditForSession },
    runtimeConfig,
    runtime,
    inbound,
    outbound,
  ] = await Promise.all([
    import('../src/memory/db.ts'),
    import('../src/config/runtime-config.ts'),
    import('../src/a2a/runtime.ts'),
    import('../src/a2a/a2a-inbound.ts'),
    import('../src/a2a/a2a-outbound.ts'),
  ]);

  initDatabase({ quiet: true });
  runtimeConfig.updateRuntimeConfig((draft) => {
    draft.agents.list = [
      {
        id: params.agentId,
        canonicalId: `${params.agentId}@team@${params.instanceId}`,
        owner: 'team',
        role: 'lead',
      },
    ];
  });

  return {
    home: params.home,
    instanceId: params.instanceId,
    getRecentStructuredAuditForSession,
    runtime,
    inbound,
    outbound,
  };
}

function activateHttpEnvelopeInstance(
  instance: Pick<
    Awaited<ReturnType<typeof loadHttpEnvelopeInstance>>,
    'home' | 'instanceId'
  >,
): void {
  process.env.HYBRIDCLAW_DATA_DIR = instance.home;
  process.env.HOME = instance.home;
  process.env.HYBRIDCLAW_INSTANCE_ID = instance.instanceId;
}

function createHttpEnvelopeServer(
  instance: Awaited<ReturnType<typeof loadHttpEnvelopeInstance>>,
): http.Server {
  return http.createServer(async (request, response) => {
    activateHttpEnvelopeInstance(instance);
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url || '/', origin);
    if (url.pathname === '/a2a/envelopes') {
      await instance.inbound.handleA2AHttpEnvelopeInbound(
        request,
        response,
        url,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
}

describe('A2A JSON-RPC inbound adapter', () => {
  test('does not persist unenforced rate limits on trusted A2A peers', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { inbound, outbound } = await loadInboundTestModules();
    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    const peer = inbound.upsertA2ATrustedA2APeer({
      peerId: 'peer-no-rate-limit',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: keyPair.publicKeyPem,
      rateLimitPerMinute: 1,
    } as Parameters<typeof inbound.upsertA2ATrustedA2APeer>[0] & {
      rateLimitPerMinute: number;
    });

    expect(peer).not.toHaveProperty('rateLimitPerMinute');
    const persisted = inbound
      .listA2ATrustedA2APeers()
      .find((entry) => entry.peerId === 'peer-no-rate-limit');
    expect(persisted).toBeDefined();
    expect(persisted).not.toHaveProperty('rateLimitPerMinute');
  });

  test('accepts a signed delegation token and delivers to the local inbox', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { getRecentStructuredAuditForSession, runtime, inbound, outbound } =
      await loadInboundTestModules();

    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'peer-prod',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: keyPair.publicKeyPem,
    });

    const envelope = inboundEnvelope('msg-inbound-a2a-1');
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );
    const token = outbound.signA2ADelegationToken({
      keyPair,
      senderAgentId: 'remote@team@peer-instance',
      targetAgentId: 'main@team@local-dev',
      audience: 'http://localhost/a2a',
      scope: outbound.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-remote-parent',
      jwtId: 'msg-inbound-a2a-1',
      messageId: 'msg-inbound-a2a-1',
      threadId: 'thread-a2a-inbound',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    const result = inbound.acceptA2AJsonRpcInboundRequest({
      rawBody,
      authorization: `Bearer ${token}`,
      audience: 'http://localhost/a2a',
      now: new Date('2030-01-01T00:00:30.000Z'),
    });

    expect(result).toMatchObject({
      statusCode: 202,
      body: {
        jsonrpc: '2.0',
        result: {
          delivered: true,
          message_id: 'msg-inbound-a2a-1',
          thread_id: 'thread-a2a-inbound',
        },
      },
    });
    expect(runtime.inbox('main')).toMatchObject([
      {
        id: 'msg-inbound-a2a-1',
        sender_agent_id: 'remote@team@peer-instance',
        recipient_agent_id: 'main@team@local-dev',
      },
    ]);
    const audit = getRecentStructuredAuditForSession(
      'a2a:inbound:peer-prod',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.inbound_post',
          peerId: 'peer-prod',
          method: 'message/send',
          agentId: 'main',
          signatureOutcome: 'passed',
          downstreamDisposition: 'delivered',
          statusCode: 202,
        }),
      ]),
    );
    const deliveredAudit = audit.find(
      (event) => event.type === 'a2a.inbound_post' && event.statusCode === 202,
    );
    expect(deliveredAudit).not.toHaveProperty('outcome');
  });

  test('accepts an HTTP envelope from an authenticated peer and preserves idempotency', async () => {
    const homeX = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-http-x-'));
    const homeY = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-a2a-http-y-'));
    let server: http.Server | null = null;

    try {
      const instanceX = await loadHttpEnvelopeInstance({
        home: homeX,
        instanceId: 'inst-x',
        agentId: 'main',
      });
      const keyPair =
        instanceX.outbound.getOrCreateA2ADelegationTokenKeyPair({
          now: new Date('2030-01-01T00:00:00.000Z'),
        });

      const instanceY = await loadHttpEnvelopeInstance({
        home: homeY,
        instanceId: 'inst-y',
        agentId: 'remote',
      });
      instanceY.inbound.upsertA2ATrustedA2APeer({
        peerId: 'instance-x',
        senderAgentId: 'main@team@inst-x',
        publicKeyPem: keyPair.publicKeyPem,
      });
      server = createHttpEnvelopeServer(instanceY);
      const port = await listen(server);
      const audience = `http://127.0.0.1:${port}/a2a/envelopes`;
      const envelope = {
        id: 'msg-http-a2a',
        sender_agent_id: 'main@team@inst-x',
        sender_instance_id: 'inst-x',
        recipient_agent_id: 'remote@team@inst-y',
        thread_id: 'thread-http-a2a',
        intent: 'chat' as const,
        content: 'HTTP envelope delivery.',
        created_at: '2026-05-01T10:00:00.000Z',
      };
      const token = instanceX.outbound.signA2ADelegationToken({
        keyPair,
        senderAgentId: envelope.sender_agent_id,
        targetAgentId: envelope.recipient_agent_id,
        audience,
        scope: instanceX.outbound.A2A_MESSAGE_SEND_SCOPE,
        parentRunId: 'run-http-envelope-parent',
        jwtId: envelope.id,
        messageId: envelope.id,
        threadId: envelope.thread_id,
      });

      const first = await fetch(audience, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      });
      await expect(first.json()).resolves.toMatchObject({
        delivered: true,
        message_id: 'msg-http-a2a',
        thread_id: 'thread-http-a2a',
      });
      expect(first.status).toBe(202);

      const second = await fetch(audience, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(envelope),
      });
      await expect(second.json()).resolves.toMatchObject({
        delivered: true,
        already_delivered: true,
        message_id: 'msg-http-a2a',
        thread_id: 'thread-http-a2a',
      });
      expect(second.status).toBe(200);

      activateHttpEnvelopeInstance(instanceY);
      expect(instanceY.runtime.inbox('remote')).toEqual([
        expect.objectContaining({
          id: 'msg-http-a2a',
          sender_agent_id: 'main@team@inst-x',
          sender_instance_id: 'inst-x',
          recipient_agent_id: 'remote@team@inst-y',
        }),
      ]);
      const audit = instanceY
        .getRecentStructuredAuditForSession('a2a:inbound:instance-x', 20)
        .map((event) => JSON.parse(event.payload || '{}'));
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'a2a.inbound_post',
            peerId: 'instance-x',
            peerInstanceId: 'inst-x',
            downstreamDisposition: 'duplicate',
            statusCode: 200,
          }),
          expect.objectContaining({
            type: 'a2a.deliver',
            actor: 'a2a:inst-x',
            source: 'a2a-runtime',
          }),
        ]),
      );
    } finally {
      if (server) await closeServer(server);
      fs.rmSync(homeX, { recursive: true, force: true });
      fs.rmSync(homeY, { recursive: true, force: true });
    }
  });

  test('rejects HTTP envelopes addressed to a different instance', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-y';
    const { runtime, inbound, outbound } = await loadInboundTestModules();
    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'instance-x',
      senderAgentId: 'main@team@inst-x',
      publicKeyPem: keyPair.publicKeyPem,
    });
    const envelope = {
      id: 'msg-http-misroute-a2a',
      sender_agent_id: 'main@team@inst-x',
      sender_instance_id: 'inst-x',
      recipient_agent_id: 'main@team@other-instance',
      thread_id: 'thread-http-misroute-a2a',
      intent: 'chat' as const,
      content: 'Wrong instance.',
      created_at: '2026-05-01T10:00:00.000Z',
    };
    const token = outbound.signA2ADelegationToken({
      keyPair,
      senderAgentId: envelope.sender_agent_id,
      targetAgentId: envelope.recipient_agent_id,
      audience: 'http://localhost/a2a/envelopes',
      scope: outbound.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-http-envelope-parent',
      jwtId: envelope.id,
      messageId: envelope.id,
      threadId: envelope.thread_id,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(
      inbound.acceptA2AHttpEnvelopeInboundRequest({
        rawBody: JSON.stringify(envelope),
        authorization: `Bearer ${token}`,
        audience: 'http://localhost/a2a/envelopes',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      statusCode: 400,
      body: {
        error: 'recipient_agent_id instance-id does not match this instance',
      },
    });
    expect(runtime.inbox('main')).toEqual([]);
  });

  test('rejects HTTP envelopes without a canonical recipient instance id', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-y';
    const { runtime, inbound, outbound } = await loadInboundTestModules();
    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'instance-x',
      senderAgentId: 'main@team@inst-x',
      publicKeyPem: keyPair.publicKeyPem,
    });

    expect(
      inbound.acceptA2AHttpEnvelopeInboundRequest({
        rawBody: JSON.stringify({
          id: 'msg-http-local-recipient-a2a',
          sender_agent_id: 'main@team@inst-x',
          sender_instance_id: 'inst-x',
          recipient_agent_id: 'main',
          thread_id: 'thread-http-local-recipient-a2a',
          intent: 'chat',
          content: 'Local recipient ids are not accepted at the peer boundary.',
          created_at: '2026-05-01T10:00:00.000Z',
        }),
        authorization: null,
        mtlsPublicKeyPem: keyPair.publicKeyPem,
        audience: 'http://localhost/a2a/envelopes',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      statusCode: 400,
      body: {
        error:
          'recipient_agent_id must be canonical (agent-slug@user@instance-id)',
      },
    });
    expect(runtime.inbox('main')).toEqual([]);
  });

  test('rejects malformed HTTP envelopes before delivery', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-y';
    const { runtime, inbound } = await loadInboundTestModules();

    expect(
      inbound.acceptA2AHttpEnvelopeInboundRequest({
        rawBody: JSON.stringify({
          id: 'msg-http-malformed-a2a',
          sender_agent_id: 'main@team@inst-x',
        }),
        authorization: null,
        audience: 'http://localhost/a2a/envelopes',
      }),
    ).toEqual({
      statusCode: 400,
      body: {
        error: expect.stringContaining('recipient_agent_id'),
      },
    });
    expect(runtime.inbox('main')).toEqual([]);
  });

  test('reports unexpected HTTP envelope auth failures as server errors', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-y';
    vi.doMock('../src/identity/agent-id.ts', async (importOriginal) => {
      const actual =
        await importOriginal<typeof import('../src/identity/agent-id.ts')>();
      return {
        ...actual,
        resolveLocalInstanceId: () => {
          throw new Error('local instance state unavailable');
        },
      };
    });
    try {
      const { getRecentStructuredAuditForSession, runtime, inbound } =
        await loadInboundTestModules();
      const keyPair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      inbound.upsertA2ATrustedA2APeer({
        peerId: 'instance-x',
        senderAgentId: 'main@team@inst-x',
        publicKeyPem: keyPair.publicKey,
      });

      expect(
        inbound.acceptA2AHttpEnvelopeInboundRequest({
          rawBody: JSON.stringify({
            id: 'msg-http-unexpected-auth-a2a',
            sender_agent_id: 'main@team@inst-x',
            sender_instance_id: 'inst-x',
            recipient_agent_id: 'remote@team@inst-y',
            thread_id: 'thread-http-unexpected-auth-a2a',
            intent: 'chat',
            content: 'Unexpected auth-path failures are server errors.',
            created_at: '2026-05-01T10:00:00.000Z',
          }),
          authorization: null,
          mtlsPublicKeyPem: keyPair.publicKey,
          audience: 'http://localhost/a2a/envelopes',
          now: new Date('2030-01-01T00:00:30.000Z'),
        }),
      ).toEqual({
        statusCode: 500,
        body: { error: 'Internal server error' },
      });
      expect(runtime.inbox('main')).toEqual([]);
      const audit = getRecentStructuredAuditForSession(
        'a2a:inbound:instance-x',
        10,
      ).map((event) => JSON.parse(event.payload || '{}'));
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'a2a.inbound_post',
            peerId: 'instance-x',
            peerInstanceId: 'inst-x',
            downstreamDisposition: 'error',
            statusCode: 500,
            reason: 'local instance state unavailable',
          }),
        ]),
      );
    } finally {
      vi.doUnmock('../src/identity/agent-id.ts');
      vi.resetModules();
    }
  });

  test('does not reveal local recipient existence before authentication', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { inbound } = await loadInboundTestModules();

    const envelope = {
      ...inboundEnvelope('msg-unknown-recipient-no-auth-a2a'),
      recipient_agent_id: 'unknown-local-agent',
    };
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );

    expect(
      inbound.acceptA2AJsonRpcInboundRequest({
        rawBody,
        authorization: null,
        audience: 'http://localhost/a2a',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      statusCode: 401,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized',
          data: {
            reason:
              'Authorization bearer token or mTLS client certificate is required',
          },
        },
        id: null,
      },
    });
  });

  test('accepts trusted mTLS client certificates and delivers to the local inbox', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { getRecentStructuredAuditForSession, runtime, inbound, outbound } =
      await loadInboundTestModules();

    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'mtls-peer',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: keyPair.publicKeyPem,
    });

    const envelope = inboundEnvelope('msg-mtls-a2a');
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );

    const result = inbound.acceptA2AJsonRpcInboundRequest({
      rawBody,
      authorization: null,
      mtlsPublicKeyPem: keyPair.publicKeyPem,
      audience: 'http://localhost/a2a',
      now: new Date('2030-01-01T00:00:30.000Z'),
    });

    expect(result).toMatchObject({
      statusCode: 202,
      body: {
        jsonrpc: '2.0',
        result: {
          delivered: true,
          message_id: 'msg-mtls-a2a',
          thread_id: 'thread-a2a-inbound',
        },
      },
    });
    expect(runtime.inbox('main')).toMatchObject([
      {
        id: 'msg-mtls-a2a',
        sender_agent_id: 'remote@team@peer-instance',
        recipient_agent_id: 'main@team@local-dev',
      },
    ]);
    const audit = getRecentStructuredAuditForSession(
      'a2a:inbound:mtls-peer',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.inbound_post',
          peerId: 'mtls-peer',
          peerInstanceId: 'peer-instance',
          method: 'message/send',
          signatureOutcome: 'passed',
          downstreamDisposition: 'delivered',
          statusCode: 202,
        }),
      ]),
    );
  });

  test('honors delegation token revocation before delivery', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { getRecentStructuredAuditForSession, runtime, inbound, outbound } =
      await loadInboundTestModules();

    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'revoked-peer',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: keyPair.publicKeyPem,
    });

    const envelope = inboundEnvelope('msg-revoked-a2a');
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );
    const token = outbound.signA2ADelegationToken({
      keyPair,
      senderAgentId: 'remote@team@peer-instance',
      targetAgentId: 'main@team@local-dev',
      audience: 'http://localhost/a2a',
      scope: outbound.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-remote-parent',
      jwtId: 'msg-revoked-a2a',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    outbound.revokeA2ADelegationTokenId('msg-revoked-a2a', {
      revokedAt: new Date('2030-01-01T00:00:10.000Z'),
    });

    const result = inbound.acceptA2AJsonRpcInboundRequest({
      rawBody,
      authorization: `Bearer ${token}`,
      audience: 'http://localhost/a2a',
      now: new Date('2030-01-01T00:00:30.000Z'),
    });

    expect(result).toEqual({
      statusCode: 401,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized',
          data: { reason: 'JWT has been revoked' },
        },
        id: null,
      },
    });
    expect(runtime.inbox('main')).toEqual([]);
    const audit = getRecentStructuredAuditForSession(
      'a2a:inbound:revoked-peer',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.inbound_post',
          signatureOutcome: 'revoked',
          downstreamDisposition: 'rejected',
          statusCode: 401,
          reason: 'JWT has been revoked',
        }),
      ]),
    );
  });

  test('audits unknown trusted senders separately from bad signatures', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { getRecentStructuredAuditForSession, inbound, outbound } =
      await loadInboundTestModules();

    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    const envelope = inboundEnvelope('msg-missing-peer-a2a');
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );
    const token = outbound.signA2ADelegationToken({
      keyPair,
      senderAgentId: 'remote@team@peer-instance',
      targetAgentId: 'main@team@local-dev',
      audience: 'http://localhost/a2a',
      scope: outbound.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-remote-parent',
      jwtId: 'msg-missing-peer-a2a',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(
      inbound.acceptA2AJsonRpcInboundRequest({
        rawBody,
        authorization: `Bearer ${token}`,
        audience: 'http://localhost/a2a',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      statusCode: 401,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized',
          data: { reason: 'No trusted A2A peer for token sender' },
        },
        id: null,
      },
    });

    const audit = getRecentStructuredAuditForSession(
      'a2a:inbound:unknown',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.inbound_post',
          signatureOutcome: 'missing_peer',
          downstreamDisposition: 'rejected',
          statusCode: 401,
          reason: 'No trusted A2A peer for token sender',
        }),
      ]),
    );
  });

  test('rejects mTLS client certificates that are not trusted for the sender', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { getRecentStructuredAuditForSession, runtime, inbound, outbound } =
      await loadInboundTestModules();

    const trustedKeyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    const untrustedKeyPair = generateKeyPairSync('ed25519');
    const untrustedPublicKeyPem = untrustedKeyPair.publicKey
      .export({ format: 'pem', type: 'spki' })
      .toString();
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'mtls-mismatch-peer',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: trustedKeyPair.publicKeyPem,
    });

    const envelope = inboundEnvelope('msg-mtls-mismatch-a2a');
    const rawBody = JSON.stringify(
      encodeA2AJsonRpcRequest(envelope, {
        url: 'http://localhost/a2a',
      }),
    );

    expect(
      inbound.acceptA2AJsonRpcInboundRequest({
        rawBody,
        authorization: null,
        mtlsPublicKeyPem: untrustedPublicKeyPem,
        audience: 'http://localhost/a2a',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      statusCode: 401,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Unauthorized',
          data: {
            reason:
              'mTLS certificate public key does not match trusted A2A peer',
          },
        },
        id: null,
      },
    });
    expect(runtime.inbox('main')).toEqual([]);
    const audit = getRecentStructuredAuditForSession(
      'a2a:inbound:mtls-mismatch-peer',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.inbound_post',
          signatureOutcome: 'failed',
          downstreamDisposition: 'rejected',
          statusCode: 401,
        }),
      ]),
    );
  });

  test('builds Agent Cards from the live registry with trust-scoped skills', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.agents.list = [
        {
          id: 'main',
          name: 'Main Agent',
          owner: 'team',
          role: 'lead',
          skills: ['public-search', 'incident-response'],
          a2a: {
            exposure: 'public',
            skillExposure: {
              'incident-response': 'trusted',
            },
          },
        },
        {
          id: 'research',
          owner: 'team',
          skills: ['deep-research'],
          a2a: { exposure: 'trusted' },
        },
        {
          id: 'private',
          owner: 'team',
          skills: ['private-skill'],
          a2a: { exposure: 'private' },
        },
      ];
    });

    const publicCard = trust.buildLocalA2AAgentCard('http://localhost');
    expect(publicCard).toMatchObject({
      url: 'http://localhost/a2a',
      capabilities: {
        messageSend: true,
        tasksSend: true,
        streaming: false,
      },
      hybridclaw: {
        instanceId: 'local-dev',
        peerTrustLevel: 'public',
      },
    });
    expect(
      (publicCard.agents as Array<{ id: string }>).map((agent) => agent.id),
    ).toEqual(['main@team@local-dev']);
    expect(
      (publicCard.skills as Array<{ name: string }>).map((skill) => skill.name),
    ).toEqual(['public-search']);

    const trustedCard = trust.buildLocalA2AAgentCard('http://localhost', {
      peerTrustLevel: 'trusted',
      peerId: 'peer-prod',
    });
    expect(
      (trustedCard.agents as Array<{ id: string }>).map((agent) => agent.id),
    ).toEqual(['main@team@local-dev', 'research@team@local-dev']);
    expect(
      (trustedCard.skills as Array<{ name: string }>).map(
        (skill) => skill.name,
      ),
    ).toEqual(['public-search', 'incident-response', 'deep-research']);
    expect(trustedCard.hybridclaw).toMatchObject({
      peerTrustLevel: 'trusted',
      peerId: 'peer-prod',
    });
  });

  test('treats trusted mTLS client certificates as trusted Agent Card readers', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    const { inbound, outbound } = await loadInboundTestModules();
    const keyPair = outbound.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    inbound.upsertA2ATrustedA2APeer({
      peerId: 'mtls-card-peer',
      senderAgentId: 'remote@team@peer-instance',
      publicKeyPem: keyPair.publicKeyPem,
    });

    expect(
      inbound.resolveA2AAgentCardPeerTrust({
        authorization: null,
        mtlsPublicKeyPem: keyPair.publicKeyPem,
        audience: 'http://localhost/.well-known/agent.json',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toEqual({
      trustLevel: 'trusted',
      peerId: 'mtls-card-peer',
    });
  });
});
