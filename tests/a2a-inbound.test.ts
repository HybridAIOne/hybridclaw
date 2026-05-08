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
        delivered: true,
        message_id: 'msg-inbound-a2a-1',
        thread_id: 'thread-a2a-inbound',
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
      body: { error: 'Unauthorized' },
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
      body: { error: 'Unauthorized' },
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
});
