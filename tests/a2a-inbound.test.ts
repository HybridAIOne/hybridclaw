import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';

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
