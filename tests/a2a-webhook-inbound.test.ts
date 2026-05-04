import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { describe, expect, test } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-webhook-inbound-');

function webhookEnvelope(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sender_agent_id: 'remote@team@peer-instance',
    recipient_agent_id: 'main',
    thread_id: 'thread-webhook-inbound',
    intent: 'chat',
    content: `Inbound webhook payload ${id}`,
    created_at: '2026-05-01T10:00:00.000Z',
    version: '1',
    ...overrides,
  };
}

describe('A2A webhook inbound adapter', () => {
  test('accepts a signed webhook envelope and delivers it to the local inbox', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const runtime = await import('../src/a2a/runtime.ts');
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const outbound = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'zapier-prod',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const rawBody = JSON.stringify(webhookEnvelope('msg-inbound-1'));
    const nowMs = Date.parse('2030-05-03T00:00:00.000Z');
    const signature = outbound.signWebhookBody({
      body: rawBody,
      secret: 'shared',
      timestampSeconds: Math.trunc(nowMs / 1000),
    });

    const result = inbound.acceptA2AWebhookInboundEnvelope({
      peerId: 'zapier-prod',
      rawBody,
      signatureHeader: signature,
      nowMs,
    });

    expect(result).toMatchObject({
      statusCode: 202,
      body: {
        delivered: true,
        message_id: 'msg-inbound-1',
        thread_id: 'thread-webhook-inbound',
      },
    });
    expect(runtime.inbox('main')).toMatchObject([
      {
        id: 'msg-inbound-1',
        sender_agent_id: 'remote@team@peer-instance',
        content: 'Inbound webhook payload msg-inbound-1',
      },
    ]);
    expect(runtime.inbox('main')[0]?.recipient_agent_id).toMatch(/^main@/);

    const audit = getRecentStructuredAuditForSession(
      'a2a:webhook-inbound:zapier-prod',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.webhook.inbound_post',
          peerId: 'zapier-prod',
          signatureOutcome: 'passed',
          intent: 'chat',
          downstreamDisposition: 'delivered',
          statusCode: 202,
        }),
      ]),
    );
  });

  test('rejects stale or invalid signatures before parsing the envelope', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const outbound = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'n8n-prod',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const rawBody = JSON.stringify({ not: 'an envelope' });
    const staleSignature = outbound.signWebhookBody({
      body: rawBody,
      secret: 'shared',
      timestampSeconds: 1,
    });

    expect(
      inbound.acceptA2AWebhookInboundEnvelope({
        peerId: 'n8n-prod',
        rawBody,
        signatureHeader: staleSignature,
        nowMs: Date.parse('2030-05-03T00:00:00.000Z'),
      }),
    ).toEqual({
      statusCode: 401,
      body: { error: 'Unauthorized' },
    });
  });

  test('rejects signed envelopes from the wrong sender or to a non-local recipient', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const outbound = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'monitor-prod',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const wrongSenderBody = JSON.stringify(
      webhookEnvelope('msg-wrong-sender', {
        sender_agent_id: 'impostor@team@peer-instance',
      }),
    );
    const nowMs = Date.parse('2030-05-03T00:00:00.000Z');
    const wrongSender = inbound.acceptA2AWebhookInboundEnvelope({
      peerId: 'monitor-prod',
      rawBody: wrongSenderBody,
      signatureHeader: outbound.signWebhookBody({
        body: wrongSenderBody,
        secret: 'shared',
        timestampSeconds: Math.trunc(nowMs / 1000),
      }),
      nowMs,
    });
    expect(wrongSender.statusCode).toBe(400);
    expect(wrongSender.body.error).toBe(
      'sender_agent_id does not match webhook peer',
    );

    const remoteRecipientBody = JSON.stringify(
      webhookEnvelope('msg-remote-recipient', {
        recipient_agent_id: 'other@team@peer-instance',
      }),
    );
    const remoteRecipient = inbound.acceptA2AWebhookInboundEnvelope({
      peerId: 'monitor-prod',
      rawBody: remoteRecipientBody,
      signatureHeader: outbound.signWebhookBody({
        body: remoteRecipientBody,
        secret: 'shared',
        timestampSeconds: Math.trunc(nowMs / 1000),
      }),
      nowMs,
    });
    expect(remoteRecipient.statusCode).toBe(400);
    expect(remoteRecipient.body.error).toBe(
      'recipient_agent_id does not resolve to a local agent',
    );
  });

  test('rate limits per peer only after signature verification succeeds', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const outbound = await import('../src/a2a/webhook-outbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'rate-limited',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
      rateLimitPerMinute: 1,
    });

    const firstBody = JSON.stringify(webhookEnvelope('msg-rate-1'));
    const secondBody = JSON.stringify(webhookEnvelope('msg-rate-2'));
    const nowMs = Date.parse('2030-05-03T00:00:00.000Z');

    expect(
      inbound.acceptA2AWebhookInboundEnvelope({
        peerId: 'rate-limited',
        rawBody: firstBody,
        signatureHeader: 't=1, v1=bad',
        nowMs,
      }),
    ).toEqual({
      statusCode: 401,
      body: { error: 'Unauthorized' },
    });

    expect(
      inbound.acceptA2AWebhookInboundEnvelope({
        peerId: 'rate-limited',
        rawBody: firstBody,
        signatureHeader: outbound.signWebhookBody({
          body: firstBody,
          secret: 'shared',
          timestampSeconds: Math.trunc(nowMs / 1000),
        }),
        nowMs,
      }).statusCode,
    ).toBe(202);

    expect(
      inbound.acceptA2AWebhookInboundEnvelope({
        peerId: 'rate-limited',
        rawBody: secondBody,
        signatureHeader: outbound.signWebhookBody({
          body: secondBody,
          secret: 'shared',
          timestampSeconds: Math.trunc(nowMs / 1000),
        }),
        nowMs,
      }),
    ).toEqual({
      statusCode: 429,
      body: { error: 'Rate limit exceeded' },
    });

    const audit = getRecentStructuredAuditForSession(
      'a2a:webhook-inbound:rate-limited',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.webhook.inbound_post',
          signatureOutcome: 'rate_limited',
          downstreamDisposition: 'rate_limited',
          statusCode: 429,
        }),
      ]),
    );
  });

  test('audits unexpected inbound handler errors before returning 500', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'broken-stream',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const req = new Readable({
      read() {
        this.destroy(new Error('stream exploded'));
      },
    }) as IncomingMessage;
    req.method = 'POST';
    req.headers = {};
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      writeHead(statusCode: number, headers: Record<string, string>) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body?: string) {
        this.body = body || '';
      },
      body: '',
    } as ServerResponse & {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };

    await inbound.handleA2AWebhookInbound(
      req,
      response,
      new URL('http://localhost/a2a/webhook/broken-stream'),
    );

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Internal server error',
    });
    const audit = getRecentStructuredAuditForSession(
      'a2a:webhook-inbound:broken-stream',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.webhook.inbound_post',
          signatureOutcome: 'failed',
          downstreamDisposition: 'error',
          statusCode: 500,
          reason: 'stream exploded',
        }),
      ]),
    );
  });

  test('rejects unknown peers before reading the request body', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const inbound = await import('../src/a2a/webhook-inbound.ts');

    initDatabase({ quiet: true });

    const req = new Readable({
      read() {
        this.destroy(new Error('body should not be read'));
      },
    }) as IncomingMessage;
    req.method = 'POST';
    req.headers = {};
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      writeHead(statusCode: number, headers: Record<string, string>) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body?: string) {
        this.body = body || '';
      },
      body: '',
    } as ServerResponse & {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };

    await inbound.handleA2AWebhookInbound(
      req,
      response,
      new URL('http://localhost/a2a/webhook/unknown-peer'),
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: 'Unauthorized' });
    const audit = getRecentStructuredAuditForSession(
      'a2a:webhook-inbound:unknown-peer',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.webhook.inbound_post',
          signatureOutcome: 'missing_peer',
          downstreamDisposition: 'rejected',
          statusCode: 401,
          reason: 'unknown webhook peer',
        }),
      ]),
    );
  });

  test('audits oversized inbound POSTs that fail before signature verification', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const inbound = await import('../src/a2a/webhook-inbound.ts');
    const secrets = await import('../src/security/runtime-secrets.ts');

    initDatabase({ quiet: true });
    secrets.saveNamedRuntimeSecrets({ A2A_INBOUND_WEBHOOK_SECRET: 'shared' });
    inbound.upsertA2AWebhookInboundPeer({
      peerId: 'oversized',
      senderAgentId: 'remote@team@peer-instance',
      secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
    });

    const req = Readable.from([
      Buffer.alloc(inbound.A2A_WEBHOOK_INBOUND_MAX_BODY_BYTES + 1),
    ]) as IncomingMessage;
    req.method = 'POST';
    req.headers = {};
    const response = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      writeHead(statusCode: number, headers: Record<string, string>) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body?: string) {
        this.body = body || '';
      },
      body: '',
    } as ServerResponse & {
      statusCode: number;
      headers: Record<string, string>;
      body: string;
    };

    await inbound.handleA2AWebhookInbound(
      req,
      response,
      new URL('http://localhost/a2a/webhook/oversized'),
    );

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: 'Request body too large.',
    });
    const audit = getRecentStructuredAuditForSession(
      'a2a:webhook-inbound:oversized',
      10,
    ).map((event) => JSON.parse(event.payload || '{}'));
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'a2a.webhook.inbound_post',
          signatureOutcome: 'failed',
          downstreamDisposition: 'rejected',
          statusCode: 413,
          reason: 'Request body too large.',
        }),
      ]),
    );
  });

  test('parses only fixed inbound webhook peer routes', async () => {
    const inbound = await import('../src/a2a/webhook-inbound.ts');

    expect(inbound.parseA2AWebhookInboundPath('/a2a/webhook/zapier')).toBe(
      'zapier',
    );
    expect(inbound.parseA2AWebhookInboundPath('/a2a/webhook/zapier/more')).toBe(
      null,
    );
    expect(inbound.parseA2AWebhookInboundPath('/api/a2a/webhook/zapier')).toBe(
      null,
    );
  });
});
