import { describe, expect, test } from 'vitest';
import { a2aOutboundAdapter } from '../src/a2a/a2a-outbound.ts';
import { type A2AEnvelope, validateA2AEnvelope } from '../src/a2a/envelope.ts';
import {
  normalizePeerDescriptor,
  PeerDescriptorValidationError,
} from '../src/a2a/peer-descriptor.ts';
import {
  encodeForRegisteredTransport,
  internalTransportAdapter,
  resolveTransportAdapter,
} from '../src/a2a/transport-registry.ts';
import { webhookOutboundAdapter } from '../src/a2a/webhook-outbound.ts';

describe('A2A transport adapter registry', () => {
  test('resolves the default internal adapter and preserves envelope shape', () => {
    const envelope = validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'main',
      recipient_agent_id: 'writer',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Draft the agenda.',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    const adapter = resolveTransportAdapter(
      normalizePeerDescriptor({ transport: 'internal', agent_id: 'writer' }),
    );

    expect(adapter).toBe(internalTransportAdapter);
    expect(adapter?.encode(envelope)).toEqual(envelope);
    expect(adapter?.decode(envelope)).toEqual(envelope);
  });

  test.each([
    [
      {
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      },
      a2aOutboundAdapter,
    ],
    [
      {
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      },
      webhookOutboundAdapter,
    ],
    [{ transport: 'smtp' }, null],
    [{ transport: 'constructor' }, null],
  ])('resolves the default adapter for %j', (descriptor, expected) => {
    expect(resolveTransportAdapter(normalizePeerDescriptor(descriptor))).toBe(
      expected,
    );
  });

  test('does not fall back to defaults for transports missing from an injected record', () => {
    expect(
      resolveTransportAdapter(
        normalizePeerDescriptor({
          transport: 'a2a',
          agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
          bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
        }),
        { internal: internalTransportAdapter },
      ),
    ).toBeNull();
  });

  test('rejects malformed peer descriptors before adapter resolution', () => {
    expect(() =>
      normalizePeerDescriptor({
        transport: 'a2a',
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'ftp://peer.example.com/hook',
        secretRef: 'plain-text-secret',
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: 'internal',
        agentId: 123,
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: 'bad transport',
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: `a${'b'.repeat(64)}`,
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: 'a2a',
        agentCardUrl: 'http://peer.example.com/.well-known/agent.json',
      }),
    ).toThrow(PeerDescriptorValidationError);
    expect(() =>
      normalizePeerDescriptor({
        transport: 'a2a',
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      }),
    ).toThrow('bearerTokenRef is required');
    expect(() =>
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
      }),
    ).toThrow('secretRef is required');
    expect(() =>
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'http://hooks.example.com/a2a',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      }),
    ).toThrow('url must use https unless targeting loopback');
    expect(() =>
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'http://128.0.0.1/a2a',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      }),
    ).toThrow('url must use https unless targeting loopback');
  });

  test('preserves raw fields for unknown transports', () => {
    expect(
      normalizePeerDescriptor({
        transport: 'smtp',
        host: 'mail.example.com',
      }),
    ).toEqual({
      transport: 'smtp',
      raw: {
        transport: 'smtp',
        host: 'mail.example.com',
      },
    });
  });

  test('normalizes transport-specific descriptor fields', () => {
    expect(
      normalizePeerDescriptor({
        transport: 'a2a',
        agent_card_url: 'https://peer.example.com/.well-known/agent.json',
        expect_public_key: true,
      }),
    ).toEqual({
      transport: 'a2a',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      expectPublicKey: true,
    });
    expect(
      normalizePeerDescriptor({
        transport: 'a2a',
        canonical_id: 'Remote@Team@Peer-Instance',
      }),
    ).toEqual({
      transport: 'a2a',
      canonicalId: 'remote@team@peer-instance',
      expectPublicKey: true,
    });
    expect(
      normalizePeerDescriptor({
        transport: 'a2a',
        url: 'https://peer.example.com/a2a',
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
      }),
    ).toEqual({
      transport: 'a2a',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
    });
    expect(
      normalizePeerDescriptor({
        transport: 'a2a',
        peer_url: 'http://127.0.0.1:8787/a2a',
      }),
    ).toEqual({
      transport: 'a2a',
      agentCardUrl: 'http://127.0.0.1:8787/.well-known/agent.json',
    });
    expect(
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'http://127.0.0.1:8787/a2a',
        secret_ref: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
        signature_header: 'X-Custom-Signature',
        version: '1',
      }),
    ).toEqual({
      transport: 'webhook',
      url: 'http://127.0.0.1:8787/a2a',
      secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
      signatureHeader: 'X-Custom-Signature',
      version: '1',
    });
  });

  test('rejects unsupported webhook body versions', () => {
    expect(() =>
      normalizePeerDescriptor({
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
        secretRef: { source: 'store', id: 'A2A_WEBHOOK_SECRET' },
        version: '2026-05-01',
      }),
    ).toThrow(/version must be 1/);
  });

  test('invokes registered non-internal adapters and returns the canonical envelope', () => {
    let encodeCalled = false;
    const adapters = {
      a2a: {
        encode(envelope: A2AEnvelope) {
        encodeCalled = true;
        return {
          jsonrpc: '2.0',
          method: 'message/send',
          params: envelope,
        };
      },
        decode() {
          return envelope;
        },
      },
    };
    const envelope = validateA2AEnvelope({
      id: 'msg-remote',
      sender_agent_id: 'main',
      recipient_agent_id: 'remote@team@peer-instance',
      thread_id: 'thread-remote',
      intent: 'chat',
      content: 'Can your peer agent receive this?',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    expect(
      encodeForRegisteredTransport({
        envelope,
        peerDescriptor: {
          transport: 'a2a',
          agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
          bearerTokenRef: { source: 'store', id: 'A2A_PEER_TOKEN' },
        },
        adapters,
      }),
    ).toEqual(envelope);
    expect(encodeCalled).toBe(true);
  });
});
