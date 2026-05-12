import { describe, expect, test, vi } from 'vitest';

import {
  sampleA2AWebhookEnvelope,
  setupA2AWebhookTestEnv,
} from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-webhook-');

describe('A2A webhook outbound adapter', () => {
  test('queues webhook envelopes and delivers a signed canonical body', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_WEBHOOK_SECRET: 'old-secret' });

    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({ autoProcess: false }),
    );

    runtime.sendMessage(sampleA2AWebhookEnvelope('msg-webhook-1'), {
      peerDescriptor: {
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      },
      transportRegistry: registry,
      sessionId: 'session-webhook',
      auditRunId: 'run-webhook',
    });

    expect(webhook.listWebhookOutboxItems()).toHaveLength(1);

    const receivedBodies: string[] = [];
    const receivedHeaders: string[] = [];
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = String(init?.body || '');
        const headers = init?.headers as Record<string, string>;
        const signature = headers[webhook.WEBHOOK_SIGNATURE_HEADER];

        receivedBodies.push(body);
        receivedHeaders.push(signature);
        return new Response('', { status: 200 });
      },
    );

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toEqual({
      processed: 1,
      delivered: 1,
      retried: 0,
      failed: 0,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://hooks.example.com/a2a',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          [webhook.WEBHOOK_SIGNATURE_HEADER]: expect.stringMatching(
            /^t=\d+, v1=[a-f0-9]{64}$/,
          ),
        }),
      }),
    );
    expect(JSON.parse(receivedBodies[0] || '{}')).toEqual({
      content: 'Webhook payload msg-webhook-1',
      created_at: '2026-05-01T10:00:00.000Z',
      id: 'msg-webhook-1',
      intent: 'chat',
      recipient_agent_id: 'remote@team@peer-instance',
      sender_agent_id: 'main',
      thread_id: 'thread-webhook',
      version: '1',
    });
    expect(receivedBodies[0]).toBe(
      '{"content":"Webhook payload msg-webhook-1","created_at":"2026-05-01T10:00:00.000Z","id":"msg-webhook-1","intent":"chat","recipient_agent_id":"remote@team@peer-instance","sender_agent_id":"main","thread_id":"thread-webhook","version":"1"}',
    );
    expect(
      webhook.verifyWebhookSignature({
        header: receivedHeaders[0],
        body: receivedBodies[0] || '',
        secret: 'old-secret',
        nowMs: Date.parse('2030-01-01T00:00:00.000Z'),
      }),
    ).toBe(true);
    const staleSignature = webhook.signWebhookBody({
      body: receivedBodies[0] || '',
      secret: 'old-secret',
      timestampSeconds: 1_000,
    });
    expect(
      webhook.verifyWebhookSignature({
        header: staleSignature,
        body: receivedBodies[0] || '',
        secret: 'old-secret',
        nowMs: Date.parse('2030-01-01T00:00:00.000Z'),
      }),
    ).toBe(false);
    expect(
      webhook.verifyWebhookSignature({
        header: staleSignature,
        body: receivedBodies[0] || '',
        secret: 'old-secret',
        nowMs: Date.parse('2030-01-01T00:00:00.000Z'),
        replayWindowMs: Number.MAX_SAFE_INTEGER,
      }),
    ).toBe(true);
    expect(webhook.listWebhookOutboxItems()[0]).toMatchObject({
      status: 'delivered',
      attempts: 1,
      lastStatusCode: 200,
    });
    expect(receivedHeaders).toHaveLength(1);
  });

  test('fails and escalates when the webhook secret cannot be resolved', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');

    initDatabase({ quiet: true });
    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({ autoProcess: false }),
    );

    runtime.sendMessage(sampleA2AWebhookEnvelope('msg-missing-secret'), {
      peerDescriptor: {
        transport: 'webhook',
        url: 'https://hooks.example.com/missing-secret',
        secretRef: { source: 'store', id: 'MISSING_WEBHOOK_SECRET' },
      },
      transportRegistry: registry,
      sessionId: 'session-webhook-missing-secret',
      auditRunId: 'run-webhook-missing-secret',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl: vi.fn(),
        now: () => new Date('2030-01-01T00:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });

    expect(
      webhook
        .listWebhookOutboxItems()
        .find((item) => item.envelope.id === 'msg-missing-secret'),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError:
        'a2a.webhook.secretRef references stored secret MISSING_WEBHOOK_SECRET but it is not set',
    });
    expect(
      getRecentStructuredAuditForSession(
        'session-webhook-missing-secret',
        10,
      ).map((event) => event.event_type),
    ).toContain('a2a.webhook.delivery_failed');
    expect(
      escalation.getSuspendedSession('session-webhook-missing-secret'),
    ).toMatchObject({
      approvalId: 'a2a-webhook-msg-missing-secret',
      status: 'pending',
    });
  });

  test('processes due webhook deliveries with bounded concurrency', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({
      A2A_WEBHOOK_SECRET: 'concurrent-secret',
    });
    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({ autoProcess: false }),
    );

    for (const id of ['msg-c1', 'msg-c2', 'msg-c3', 'msg-c4']) {
      runtime.sendMessage(sampleA2AWebhookEnvelope(id), {
        peerDescriptor: {
          transport: 'webhook',
          url: `https://hooks.example.com/${id}`,
          secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
        },
        transportRegistry: registry,
      });
    }

    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response('', { status: 200 });
    });

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl,
        concurrency: 2,
      }),
    ).resolves.toMatchObject({
      processed: 4,
      delivered: 4,
    });
    expect(maxActive).toBe(2);
  });

  test('processor startup sweep drains retried items without another send', async () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_WEBHOOK_SECRET: 'startup-secret' });
    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({ autoProcess: false }),
    );
    runtime.sendMessage(sampleA2AWebhookEnvelope('msg-startup-sweep'), {
      peerDescriptor: {
        transport: 'webhook',
        url: 'https://hooks.example.com/startup-sweep',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      },
      transportRegistry: registry,
    });

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 503 })),
        now: () => new Date(),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, retried: 1 });

    vi.setSystemTime(new Date('2030-01-01T00:00:02.000Z'));
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 202 }));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      webhook.startWebhookOutboxProcessor(1_000);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      webhook.stopWebhookOutboxProcessor();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      webhook
        .listWebhookOutboxItems()
        .find((item) => item.envelope.id === 'msg-startup-sweep'),
    ).toMatchObject({
      status: 'delivered',
      attempts: 2,
    });
  });

  test('retries transient failures and fails fast on 4xx responses', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const escalation = await import('../src/gateway/interactive-escalation.ts');
    const runtime = await import('../src/a2a/runtime.ts');
    const transport = await import('../src/a2a/transport-registry.ts');
    const webhook = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_WEBHOOK_SECRET: 'retry-secret' });

    const registry = new transport.TransportRegistry();
    registry.register(
      new webhook.WebhookOutboundAdapter({
        autoProcess: false,
        maxAttempts: 2,
      }),
    );

    runtime.sendMessage(sampleA2AWebhookEnvelope('msg-retry'), {
      peerDescriptor: {
        transport: 'webhook',
        url: 'https://hooks.example.com/retry',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      },
      transportRegistry: registry,
      sessionId: 'session-webhook-retry',
      auditRunId: 'run-webhook-retry',
    });

    const retryFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 202 }));
    await expect(
      webhook.processWebhookOutbox({
        fetchImpl: retryFetch,
        now: () => new Date('2030-01-01T00:00:00.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, retried: 1 });
    expect(webhook.listWebhookOutboxItems()[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastStatusCode: 503,
      nextAttemptAt: '2030-01-01T00:00:01.000Z',
    });

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl: retryFetch,
        now: () => new Date('2030-01-01T00:00:01.000Z'),
        jitterRatio: 0,
      }),
    ).resolves.toMatchObject({ processed: 1, delivered: 1 });

    runtime.sendMessage(sampleA2AWebhookEnvelope('msg-fail-fast'), {
      peerDescriptor: {
        transport: 'webhook',
        url: 'https://hooks.example.com/fail-fast',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      },
      transportRegistry: registry,
      sessionId: 'session-webhook-fail',
      auditRunId: 'run-webhook-fail',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });

    await expect(
      webhook.processWebhookOutbox({
        fetchImpl: vi.fn().mockResolvedValue(new Response('', { status: 401 })),
        now: () => new Date('2030-01-01T00:00:02.000Z'),
      }),
    ).resolves.toMatchObject({ processed: 1, failed: 1 });

    expect(
      webhook
        .listWebhookOutboxItems()
        .find((item) => item.envelope.id === 'msg-fail-fast'),
    ).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastStatusCode: 401,
    });
    expect(
      getRecentStructuredAuditForSession('session-webhook-fail', 10).map(
        (event) => event.event_type,
      ),
    ).toContain('a2a.webhook.delivery_failed');
    expect(
      escalation.getSuspendedSession('session-webhook-fail'),
    ).toMatchObject({
      approvalId: 'a2a-webhook-msg-fail-fast',
      status: 'pending',
      escalationTarget: {
        channel: 'slack:COPS',
        recipient: 'ops-lead',
      },
    });
  });
});
