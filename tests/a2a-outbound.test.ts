import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import {
  decodeA2AJsonRpcRequest,
  encodeA2AJsonRpcRequest,
} from '../src/a2a/a2a-json-rpc.ts';
import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-outbound-');

function sampleA2AEnvelope(id: string, intent: 'chat' | 'handoff' = 'chat') {
  return {
    id,
    sender_agent_id: 'main',
    recipient_agent_id: 'remote@team@peer-instance',
    sender_instance_id: 'local',
    thread_id: 'thread-a2a',
    intent,
    content: `A2A payload ${id}`,
    created_at: '2026-05-01T10:00:00.000Z',
  };
}

function publicKeyJwk() {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
}

describe('A2A outbound adapter', () => {
  test('queues envelopes, fetches Agent Cards with ETag refresh, and sends message/send', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_PEER_TOKEN: 'peer-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    const descriptor = {
      transport: 'a2a',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
    } as const;

    runtime.sendMessage(sampleA2AEnvelope('msg-a2a-1'), {
      peerDescriptor: descriptor,
      transportRegistry: registry,
      sessionId: 'session-a2a-outbound',
      auditRunId: 'run-a2a-outbound',
    });

    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
      ifNoneMatch: string;
      body: string;
      redirect?: RequestRedirect;
    }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        requests.push({
          url: String(url),
          method: init?.method || 'GET',
          authorization: headers?.authorization || '',
          ifNoneMatch: headers?.['if-none-match'] || '',
          body: String(init?.body || ''),
          redirect: init?.redirect,
        });
        if (init?.method === 'GET') {
          return Response.json(
            {
              name: 'Peer',
              url: 'https://peer.example.com/a2a',
              capabilities: [],
            },
            { headers: { etag: '"card-v1"' } },
          );
        }
        return Response.json({ jsonrpc: '2.0', result: { kind: 'message' } });
      },
    );

    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        agentCardCacheTtlMs: 1,
      }),
    ).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    });

    const rpc = JSON.parse(requests[1]?.body || '{}');
    expect(requests[0]).toMatchObject({
      url: 'https://peer.example.com/.well-known/agent.json',
      method: 'GET',
      authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]+\./),
      redirect: 'error',
    });
    expect(requests[1]).toMatchObject({
      url: 'https://peer.example.com/a2a',
      method: 'POST',
      authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]+\./),
      redirect: 'error',
    });
    expect(rpc).toMatchObject({
      jsonrpc: '2.0',
      method: 'message/send',
      params: {
        message: {
          messageId: 'msg-a2a-1',
          contextId: 'thread-a2a',
          parts: [
            {
              kind: 'text',
              text: 'A2A payload msg-a2a-1',
              metadata: {
                hybridclaw: {
                  intent: 'chat',
                },
              },
            },
          ],
        },
        metadata: {
          hybridclaw: {
            intent: 'chat',
          },
        },
      },
    });
    expect(rpc.id).toBeUndefined();
    expect(decodeA2AJsonRpcRequest(rpc)).toEqual(
      expect.objectContaining({
        ...sampleA2AEnvelope('msg-a2a-1'),
        sender_agent_id: expect.stringMatching(/^main@local@inst-/),
        sender_instance_id: expect.stringMatching(/^inst-/),
      }),
    );
    const keyPair = a2a.getOrCreateA2ADelegationTokenKeyPair();
    const agentCardToken = requests[0]?.authorization.replace(/^Bearer /, '');
    const deliveryToken = requests[1]?.authorization.replace(/^Bearer /, '');
    expect(agentCardToken).toBeTruthy();
    expect(deliveryToken).toBeTruthy();
    const agentCardClaims = a2a.verifyA2ADelegationToken({
      token: agentCardToken || '',
      publicKeyPem: keyPair.publicKeyPem,
      audience: 'https://peer.example.com/.well-known/agent.json',
      requiredScope: a2a.A2A_AGENT_CARD_READ_SCOPE,
      targetAgentId: 'remote@team@peer-instance',
      now: new Date('2030-01-01T00:00:30.000Z'),
    });
    expect(agentCardClaims).toMatchObject({
      iss: 'hybridclaw',
      aud: 'https://peer.example.com/.well-known/agent.json',
      jti: 'msg-a2a-1',
      parent_run_id: 'run-a2a-outbound',
      message_id: 'msg-a2a-1',
      thread_id: 'thread-a2a',
      target_agent_id: 'remote@team@peer-instance',
      scope: [a2a.A2A_AGENT_CARD_READ_SCOPE],
    });
    expect(agentCardClaims.sender_agent_id).toMatch(/^main@/);
    expect(agentCardClaims.exp - agentCardClaims.iat).toBe(
      a2a.A2A_DELEGATION_TOKEN_TTL_SECONDS,
    );
    expect(
      a2a.verifyA2ADelegationToken({
        token: deliveryToken || '',
        publicKeyPem: keyPair.publicKeyPem,
        audience: 'https://peer.example.com/a2a',
        requiredScope: a2a.A2A_MESSAGE_SEND_SCOPE,
        targetAgentId: 'remote@team@peer-instance',
        now: new Date('2030-01-01T00:00:30.000Z'),
      }),
    ).toMatchObject({
      aud: 'https://peer.example.com/a2a',
      scope: [a2a.A2A_MESSAGE_SEND_SCOPE],
      parent_run_id: 'run-a2a-outbound',
    });
    const audit = getRecentStructuredAuditForSession(
      'session-a2a-outbound',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.outbound.delegation_auth',
          authMode: expect.stringMatching(/jwt$/),
          bearerTokenRefRole: expect.stringMatching(/^non.*gate$/),
          bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
          audience: 'https://peer.example.com/a2a',
          scope: a2a.A2A_MESSAGE_SEND_SCOPE,
        }),
      ]),
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-a2a-2'), {
      peerDescriptor: descriptor,
      transportRegistry: registry,
    });
    fetchImpl.mockImplementation(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        requests.push({
          url: String(url),
          method: init?.method || 'GET',
          authorization: headers?.authorization || '',
          ifNoneMatch: headers?.['if-none-match'] || '',
          body: String(init?.body || ''),
          redirect: init?.redirect,
        });
        if (init?.method === 'GET') {
          return new Response(null, { status: 304 });
        }
        return Response.json({ jsonrpc: '2.0', result: { kind: 'message' } });
      },
    );
    const secondResult = await a2a.processA2AOutbox({
      fetchImpl,
      now: () => new Date('2030-01-01T00:00:00.010Z'),
      agentCardCacheTtlMs: 1,
    });
    expect(secondResult).toMatchObject({
      processed: 1,
      delivered: 1,
    });
    expect(
      requests.find((request) => request.ifNoneMatch === '"card-v1"'),
    ).toBeTruthy();
  });

  test('uses one default audit session for queued send and delivery events', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const audit = await import('../src/audit/audit-trail.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    runtime.sendMessage(sampleA2AEnvelope('msg-a2a-default-audit'), {
      peerDescriptor: {
        transport: 'a2a',
        url: 'http://127.0.0.1:65535/a2a',
      },
      transportRegistry: registry,
    });

    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return Response.json({
            name: 'Peer',
            url: 'http://127.0.0.1:65535/a2a',
            capabilities: [],
          });
        }
        return Response.json({ jsonrpc: '2.0', result: { kind: 'message' } });
      },
    );

    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    });

    const sessionId = 'a2a:thread:thread-a2a';
    const records = fs
      .readFileSync(audit.getAuditWirePath(sessionId), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(1)
      .map((line) => JSON.parse(line));
    const canonicalEvents = records.filter((record) =>
      ['a2a.send', 'a2a.deliver'].includes(record.event.type),
    );

    expect(canonicalEvents.map((record) => record.event.type)).toEqual([
      'a2a.send',
      'a2a.deliver',
    ]);
    expect(canonicalEvents.map((record) => record.event.transport)).toEqual([
      'a2a',
      'a2a',
    ]);
    expect(audit.verifyAuditSessionChain(sessionId)).toMatchObject({
      ok: true,
      errors: [],
    });
  });

  test('honors delegation token revocations and expiry', async () => {
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const keyPair = a2a.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    const token = a2a.signA2ADelegationToken({
      keyPair,
      senderAgentId: 'main@team@local-dev',
      targetAgentId: 'remote@team@peer-instance',
      audience: 'https://peer.example.com/a2a',
      scope: a2a.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-parent',
      jwtId: 'msg-revocable',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(
      a2a.verifyA2ADelegationToken({
        token,
        publicKeyPem: keyPair.publicKeyPem,
        audience: 'https://peer.example.com/a2a',
        requiredScope: a2a.A2A_MESSAGE_SEND_SCOPE,
        senderAgentId: 'main@team@local-dev',
        targetAgentId: 'remote@team@peer-instance',
        now: new Date('2030-01-01T00:00:01.000Z'),
      }),
    ).toMatchObject({
      jti: 'msg-revocable',
      parent_run_id: 'run-parent',
      sender_agent_id: 'main@team@local-dev',
      target_agent_id: 'remote@team@peer-instance',
    });

    expect(() =>
      a2a.verifyA2ADelegationToken({
        token,
        publicKeyPem: keyPair.publicKeyPem,
        audience: 'https://peer.example.com/a2a',
        requiredScope: a2a.A2A_MESSAGE_SEND_SCOPE,
        now: new Date('2030-01-01T00:06:00.000Z'),
      }),
    ).toThrow('JWT has expired');

    a2a.revokeA2ADelegationTokenId('msg-revocable', {
      revokedAt: new Date('2030-01-01T00:01:00.000Z'),
    });
    expect(a2a.isA2ADelegationTokenRevoked('msg-revocable')).toBe(true);
    expect(() =>
      a2a.verifyA2ADelegationToken({
        token,
        publicKeyPem: keyPair.publicKeyPem,
        audience: 'https://peer.example.com/a2a',
        requiredScope: a2a.A2A_MESSAGE_SEND_SCOPE,
        now: new Date('2030-01-01T00:01:01.000Z'),
      }),
    ).toThrow('JWT has been revoked');
  });

  test('prunes expired delegation token revocations', async () => {
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    a2a.revokeA2ADelegationTokenId('msg-old-revocation', {
      revokedAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(a2a.isA2ADelegationTokenRevoked('msg-old-revocation')).toBe(true);

    a2a.revokeA2ADelegationTokenId('msg-new-revocation', {
      revokedAt: new Date('2030-01-01T00:06:00.000Z'),
    });

    expect(a2a.isA2ADelegationTokenRevoked('msg-old-revocation')).toBe(false);
    expect(a2a.isA2ADelegationTokenRevoked('msg-new-revocation')).toBe(true);
  });

  test('rejects tampered delegation tokens before parsing claims', async () => {
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const keyPair = a2a.getOrCreateA2ADelegationTokenKeyPair({
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    const token = a2a.signA2ADelegationToken({
      keyPair,
      senderAgentId: 'main@team@local-dev',
      targetAgentId: 'remote@team@peer-instance',
      audience: 'https://peer.example.com/a2a',
      scope: a2a.A2A_MESSAGE_SEND_SCOPE,
      parentRunId: 'run-parent',
      jwtId: 'msg-tampered',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    const [headerSegment = '', payloadSegment = '', signatureSegment = ''] =
      token.split('.');
    const payload = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf-8'),
    );
    const tamperedPayloadSegment = Buffer.from(
      JSON.stringify({
        ...payload,
        sub: 'not-canonical',
        sender_agent_id: 'not-canonical',
      }),
    ).toString('base64url');

    expect(() =>
      a2a.verifyA2ADelegationToken({
        token: `${headerSegment}.${tamperedPayloadSegment}.${signatureSegment}`,
        publicKeyPem: keyPair.publicKeyPem,
        now: new Date('2030-01-01T00:00:01.000Z'),
      }),
    ).toThrow('JWT signature is invalid');
  });

  test('uses tasks/send for handoff when the peer advertises task capability', async () => {
    const request = encodeA2AJsonRpcRequest(
      sampleA2AEnvelope('msg-task', 'handoff'),
      {
        url: 'https://peer.example.com/a2a',
        capabilities: ['tasks/send'],
      },
    );

    expect(request.method).toBe('tasks/send');
    expect(request.id).toBe('msg-task');
    expect(request.params.metadata.hybridclaw.intent).toBe('handoff');
  });

  test('requires a JSON-RPC response body for tasks/send', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_PEER_TOKEN: 'peer-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    runtime.sendMessage(sampleA2AEnvelope('msg-empty-task', 'handoff'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      },
      transportRegistry: registry,
    });

    await expect(
      a2a.processA2AOutbox({
        fetchImpl: vi
          .fn()
          .mockResolvedValueOnce(
            Response.json({
              url: 'https://peer.example.com/a2a',
              capabilities: ['tasks/send'],
            }),
          )
          .mockResolvedValueOnce(new Response('', { status: 202 })),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError: 'tasks/send requires a well-formed JSON-RPC response body',
    });
  });

  test('validates Agent Card delivery URLs before caching or sending', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_PEER_TOKEN: 'peer-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    runtime.sendMessage(sampleA2AEnvelope('msg-bad-card-url'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      },
      transportRegistry: registry,
    });

    await expect(
      a2a.processA2AOutbox({
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({
            url: 'http://169.254.169.254/a2a',
            capabilities: [],
          }),
        ),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError: 'Agent Card url must use https unless targeting loopback',
    });
  });

  test('uses TOFU public-key auth when the Agent Card publishes a peer key', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const peerKey = publicKeyJwk();
    const requests: Array<{
      method: string;
      authorization: string;
      body: string;
    }> = [];
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        requests.push({
          method: init?.method || 'GET',
          authorization: headers?.authorization || '',
          body: String(init?.body || ''),
        });
        if (init?.method === 'GET') {
          return Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: peerKey,
            },
          });
        }
        return Response.json({ jsonrpc: '2.0', result: { kind: 'message' } });
      },
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-tofu'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        expectPublicKey: true,
      },
      transportRegistry: registry,
      auditRunId: 'run-a2a-tofu',
    });

    await expect(a2a.processA2AOutbox({ fetchImpl })).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    });

    expect(requests[0]?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\./);
    expect(requests[1]?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\./);
    const token = requests[1]?.authorization.replace(/^Bearer /, '') || '';
    const [header] = token.split('.');
    expect(
      JSON.parse(Buffer.from(header || '', 'base64url').toString()),
    ).toEqual(expect.objectContaining({ alg: 'EdDSA' }));
    expect(trust.getA2ATrustedPublicKeyPeer('peer-prod')).toMatchObject({
      peerId: 'peer-prod',
      status: 'trusted',
    });
    expect(
      getRecentStructuredAuditForSession('a2a:trust-ledger', 10).map(
        (event) => event.event_type,
      ),
    ).toContain('a2a.trust.granted');
  });

  test('resolves canonical A2A peer destinations through identity discovery', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const peerKey = publicKeyJwk();
    const resolver = {
      resolve: vi.fn(async (canonicalId: string) => {
        expect(canonicalId).toBe('remote@team@peer-instance');
        return {
          url: 'https://peer.example.com',
          publicKey: JSON.stringify(peerKey),
        };
      }),
    };
    const requests: Array<{
      url: string;
      method: string;
      authorization: string;
      body: string;
    }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        requests.push({
          url: String(url),
          method: init?.method || 'GET',
          authorization: headers?.authorization || '',
          body: String(init?.body || ''),
        });
        if (init?.method === 'GET') {
          return Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: peerKey,
            },
          });
        }
        return Response.json({ jsonrpc: '2.0', result: { ok: true } });
      },
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-resolved-peer'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
    });

    await expect(
      a2a.processA2AOutbox({ fetchImpl, identityResolver: resolver }),
    ).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    });

    expect(requests[0]).toMatchObject({
      url: 'https://peer.example.com/.well-known/agent.json',
      method: 'GET',
      authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]+\./),
    });
    expect(requests[1]).toMatchObject({
      url: 'https://peer.example.com/a2a',
      method: 'POST',
      authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]+\./),
    });
    expect(trust.getA2ATrustedPublicKeyPeer('peer-prod')).toMatchObject({
      publicKeyFingerprint: trust.fingerprintA2APublicKey(peerKey),
      status: 'trusted',
    });
  });

  test('uses the default A2A resolver for trusted canonical peers', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const peerKey = publicKeyJwk();
    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'peer-instance',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      publicKeyJwk: peerKey,
    });
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          method: init?.method || 'GET',
        });
        if (init?.method === 'GET') {
          return Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-instance',
              publicKeyJwk: peerKey,
            },
          });
        }
        return Response.json({ jsonrpc: '2.0', result: { ok: true } });
      },
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-default-resolver'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
    });

    await expect(a2a.processA2AOutbox({ fetchImpl })).resolves.toMatchObject({
      processed: 1,
      delivered: 1,
    });
    expect(requests).toEqual([
      {
        url: 'https://peer.example.com/.well-known/agent.json',
        method: 'GET',
      },
      {
        url: 'https://peer.example.com/a2a',
        method: 'POST',
      },
    ]);
  });

  test('fails unresolved queued messages fast when canonical peer trust was revoked', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'peer-instance',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      publicKeyJwk: publicKeyJwk(),
    });
    trust.revokeA2ATrustedPublicKeyPeer('peer-instance');

    runtime.sendMessage(sampleA2AEnvelope('msg-revoked-canonical'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
    });

    await expect(a2a.processA2AOutbox()).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('peer-untrusted'),
    });
  });

  test('records resolved canonical peer destinations on retry audits', async () => {
    const { getRecentStructuredAuditForSession, initDatabase } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const peerKey = publicKeyJwk();

    runtime.sendMessage(sampleA2AEnvelope('msg-resolved-peer-retry'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
      sessionId: 'session-resolved-peer-retry',
    });

    await expect(
      a2a.processA2AOutbox({
        identityResolver: {
          async resolve() {
            return {
              url: 'https://peer.example.com',
              publicKey: JSON.stringify(peerKey),
            };
          },
        },
        fetchImpl: vi
          .fn()
          .mockResolvedValueOnce(
            Response.json({
              url: 'https://peer.example.com/a2a',
              capabilities: [],
              hybridclaw: {
                instanceId: 'peer-prod',
                publicKeyJwk: peerKey,
              },
            }),
          )
          .mockResolvedValueOnce(new Response('', { status: 503 })),
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({
      processed: 1,
      retried: 1,
    });

    const retryAudit = getRecentStructuredAuditForSession(
      'session-resolved-peer-retry',
      5,
    )
      .map((event) => JSON.parse(event.payload || '{}'))
      .find((event) => event.type === 'a2a.outbound.delivery_retry');
    expect(retryAudit).toMatchObject({
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      canonicalId: 'remote@team@peer-instance',
      statusCode: 503,
    });
  });

  test('rejects resolved peers whose Agent Card key does not match discovery', async () => {
    const { getRecentStructuredAuditForSession, initDatabase } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const resolverKey = publicKeyJwk();
    const cardKey = publicKeyJwk();

    runtime.sendMessage(sampleA2AEnvelope('msg-resolved-peer-mismatch'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
      sessionId: 'session-resolved-peer-mismatch',
    });

    await expect(
      a2a.processA2AOutbox({
        identityResolver: {
          async resolve() {
            return {
              url: 'https://peer.example.com',
              publicKey: JSON.stringify(resolverKey),
            };
          },
        },
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: cardKey,
            },
          }),
        ),
      }),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError:
        'A2A identity discovery public key mismatch for remote@team@peer-instance',
    });
    const failureAudit = getRecentStructuredAuditForSession(
      'session-resolved-peer-mismatch',
      5,
    )
      .map((event) => JSON.parse(event.payload || '{}'))
      .find((event) => event.type === 'a2a.outbound.delivery_failed');
    expect(failureAudit).toMatchObject({
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      canonicalId: 'remote@team@peer-instance',
    });
  });

  test('rejects malformed resolved public key fingerprints before mismatch checks', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const cardKey = publicKeyJwk();

    runtime.sendMessage(sampleA2AEnvelope('msg-resolved-peer-bad-key'), {
      peerDescriptor: {
        transport: 'a2a',
        canonicalId: 'remote@team@peer-instance',
      },
      transportRegistry: registry,
    });

    await expect(
      a2a.processA2AOutbox({
        identityResolver: {
          async resolve() {
            return {
              url: 'https://peer.example.com',
              publicKey: 'not-a-valid-fingerprint',
            };
          },
        },
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: cardKey,
            },
          }),
        ),
      }),
    ).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('unsupported public key format'),
    });
  });

  test('fails and audits when a TOFU peer key changes', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const firstPeerKey = publicKeyJwk();
    const secondPeerKey = publicKeyJwk();
    let currentPeerKey = firstPeerKey;
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'GET') {
          return Response.json({
            url: 'https://peer.example.com/a2a',
            capabilities: [],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: currentPeerKey,
            },
          });
        }
        return Response.json({ jsonrpc: '2.0', result: { kind: 'message' } });
      },
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-tofu-first'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        expectPublicKey: true,
      },
      transportRegistry: registry,
    });
    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        agentCardCacheTtlMs: 1,
      }),
    ).resolves.toMatchObject({
      delivered: 1,
    });

    currentPeerKey = secondPeerKey;
    runtime.sendMessage(sampleA2AEnvelope('msg-tofu-mismatch'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        expectPublicKey: true,
      },
      transportRegistry: registry,
      sessionId: 'session-a2a-mismatch',
    });
    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.010Z'),
        agentCardCacheTtlMs: 1,
      }),
    ).resolves.toMatchObject({
      failed: 1,
    });

    expect(
      a2a
        .listA2AOutboxItems()
        .find((item) => item.envelope.id === 'msg-tofu-mismatch'),
    ).toMatchObject({
      status: 'failed',
      lastError: expect.stringContaining('public key mismatch'),
    });
    expect(
      getRecentStructuredAuditForSession('a2a:trust-ledger', 10).map(
        (event) => event.event_type,
      ),
    ).toContain('a2a.trust.mismatch');
  });

  test('requires bearer auth based on the resolved delivery URL', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());

    runtime.sendMessage(sampleA2AEnvelope('msg-remote-delivery-no-auth'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'http://127.0.0.1:8787/.well-known/agent.json',
      },
      transportRegistry: registry,
    });

    let agentCardAuthorization = '';
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        agentCardAuthorization = headers?.authorization || '';
        return Response.json({
          url: 'https://peer.example.com/a2a',
          capabilities: [],
        });
      },
    );
    await expect(a2a.processA2AOutbox({ fetchImpl })).resolves.toMatchObject({
      processed: 1,
      failed: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(agentCardAuthorization).toMatch(/^Bearer [A-Za-z0-9_-]+\./);
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      lastError: 'a2a.bearerTokenRef is required for non-loopback peers',
    });
  });

  test('fails unresolved recipients without retrying missing identity records', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const { IdentityNotFoundError } = await import(
      '../src/identity/resolver.ts'
    );

    initDatabase({ quiet: true });
    a2a.enqueueUnresolvedA2AEnvelope(
      sampleA2AEnvelope('msg-missing-identity'),
      'remote@team@peer-instance',
    );
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      identityResolution: {
        status: 'unresolved',
        canonicalId: 'remote@team@peer-instance',
      },
    });

    await expect(
      a2a.processA2AOutbox({
        identityResolver: {
          async resolve(canonicalId: string) {
            throw new IdentityNotFoundError(canonicalId);
          },
        },
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError:
        'No identity discovery record found for remote@team@peer-instance.',
    });
  });

  test('fails closed when identity discovery returns an unsupported public key', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');

    initDatabase({ quiet: true });
    a2a.enqueueUnresolvedA2AEnvelope(
      sampleA2AEnvelope('msg-invalid-discovery-key'),
      'remote@team@peer-instance',
    );

    await expect(
      a2a.processA2AOutbox({
        identityResolver: {
          async resolve() {
            return {
              url: 'http://127.0.0.1:8787',
              publicKey: 'not-a-valid-key',
            };
          },
        },
        fetchImpl: vi.fn().mockResolvedValue(
          Response.json({
            url: 'http://127.0.0.1:8787/a2a',
            capabilities: [],
          }),
        ),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'failed',
      identityResolution: {
        status: 'resolved',
        canonicalId: 'remote@team@peer-instance',
        publicKey: 'not-a-valid-key',
      },
      lastError: expect.stringContaining('unsupported public key format'),
    });
  });

  test('keys Agent Card cache by auth context', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({
      A2A_PEER_TOKEN_A: 'peer-secret-a',
      A2A_PEER_TOKEN_B: 'peer-secret-b',
    });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter());
    const agentCardUrl = 'https://peer.example.com/.well-known/agent.json';
    const requests: Array<{ url: string; method: string; body: string }> = [];
    let cardFetches = 0;
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(url),
          method: init?.method || 'GET',
          body: String(init?.body || ''),
        });
        if (init?.method === 'GET') {
          cardFetches += 1;
          const suffix = cardFetches === 1 ? 'a' : 'b';
          return Response.json({
            url: `https://peer-${suffix}.example.com/a2a`,
            capabilities: [],
          });
        }
        return Response.json({ jsonrpc: '2.0', result: {} });
      },
    );

    runtime.sendMessage(sampleA2AEnvelope('msg-cache-a'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl,
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN_A' },
      },
      transportRegistry: registry,
    });
    await a2a.processA2AOutbox({ fetchImpl });

    runtime.sendMessage(sampleA2AEnvelope('msg-cache-b'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl,
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN_B' },
      },
      transportRegistry: registry,
    });
    await a2a.processA2AOutbox({ fetchImpl });

    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(
      2,
    );
    expect(
      requests.filter(
        (request) => request.url === 'https://peer-b.example.com/a2a',
      ),
    ).toHaveLength(1);
  });

  test('caps Agent Card cache size and refetches evicted entries', async () => {
    const cards = await import('../src/a2a/a2a-agent-card.ts');

    cards.clearA2AAgentCardCache();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      Response.json({
        url: String(url).replace('/.well-known/agent.json', '/a2a'),
        capabilities: [],
      }),
    );

    for (
      let index = 0;
      index <= cards.A2A_AGENT_CARD_CACHE_MAX_ENTRIES;
      index += 1
    ) {
      await cards.fetchA2AAgentCard({
        agentCardUrl: `https://peer-${index}.example.com/.well-known/agent.json`,
        fetchImpl,
        now: new Date('2030-01-01T00:00:00.000Z'),
      });
    }

    await cards.fetchA2AAgentCard({
      agentCardUrl: 'https://peer-0.example.com/.well-known/agent.json',
      fetchImpl,
      now: new Date('2030-01-01T00:00:01.000Z'),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(
      cards.A2A_AGENT_CARD_CACHE_MAX_ENTRIES + 2,
    );
  });

  test('retries transient responses and fails fast with audit escalation on 4xx', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_PEER_TOKEN: 'peer-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter({ maxAttempts: 2 }));

    runtime.sendMessage(sampleA2AEnvelope('msg-retry'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      },
      transportRegistry: registry,
      sessionId: 'session-a2a-retry',
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          url: 'https://peer.example.com/a2a',
          capabilities: [],
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ jsonrpc: '2.0', result: {} }));

    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, retried: 1 });
    expect(a2a.listA2AOutboxItems()[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastStatusCode: 503,
      nextAttemptAt: '2030-01-01T00:00:01.000Z',
    });

    await expect(
      a2a.processA2AOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:01.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, delivered: 1 });

    runtime.sendMessage(sampleA2AEnvelope('msg-fail-fast'), {
      peerDescriptor: {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      },
      transportRegistry: registry,
      sessionId: 'session-a2a-fail',
      auditRunId: 'run-a2a-fail',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });

    await expect(
      a2a.processA2AOutbox({
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 401 })),
        now: () => new Date('2030-01-01T00:00:02.000Z'),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });

    expect(
      a2a
        .listA2AOutboxItems()
        .find((item) => item.envelope.id === 'msg-fail-fast'),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatusCode: 401,
    });
    expect(
      getRecentStructuredAuditForSession('session-a2a-fail', 10).map(
        (event) => event.event_type,
      ),
    ).toContain('a2a.outbound.delivery_failed');
    expect(escalation.getSuspendedSession('session-a2a-fail')).toMatchObject({
      approvalId: 'a2a-outbound-msg-fail-fast',
      status: 'pending',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });
  });
});
