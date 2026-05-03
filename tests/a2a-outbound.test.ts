import { describe, expect, test, vi } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-outbound-');

function sampleA2AEnvelope(id: string, intent: 'chat' | 'handoff' = 'chat') {
  return {
    id,
    sender_agent_id: 'main',
    recipient_agent_id: 'remote@team@peer-instance',
    thread_id: 'thread-a2a',
    intent,
    content: `A2A payload ${id}`,
    created_at: '2026-05-01T10:00:00.000Z',
  };
}

describe('A2A outbound adapter', () => {
  test('queues envelopes, fetches Agent Cards with ETag refresh, and sends message/send', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_PEER_TOKEN: 'peer-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(new a2a.A2AOutboundAdapter({ autoProcess: false }));

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
    });
    expect(requests[1]).toMatchObject({
      url: 'https://peer.example.com/a2a',
      method: 'POST',
      authorization: expect.stringMatching(/^Bearer [A-Za-z0-9_-]+\./),
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
    expect(a2a.decodeA2AJsonRpcRequest(rpc)).toEqual(
      sampleA2AEnvelope('msg-a2a-1'),
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

  test('uses tasks/send for handoff when the peer advertises task capability', async () => {
    const a2a = await import('../src/a2a/a2a-outbound.ts');
    const request = a2a.encodeA2AJsonRpcRequest(
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
    registry.register(
      new a2a.A2AOutboundAdapter({ autoProcess: false, maxAttempts: 2 }),
    );

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
