import { describe, expect, test } from 'vitest';

import { validateA2AEnvelope } from '../src/a2a/envelope.ts';
import {
  normalizePeerDescriptor,
  PeerDescriptorValidationError,
} from '../src/a2a/peer-descriptor.ts';
import {
  createDefaultTransportRegistry,
  encodeForRegisteredTransport,
  internalTransportAdapter,
  type TransportAdapter,
  TransportRegistryError,
} from '../src/a2a/transport-registry.ts';

describe('A2A transport adapter registry', () => {
  test('resolves the default internal adapter and preserves envelope shape', () => {
    const registry = createDefaultTransportRegistry();
    const envelope = validateA2AEnvelope({
      id: 'msg-1',
      sender_agent_id: 'main',
      recipient_agent_id: 'writer',
      thread_id: 'thread-1',
      intent: 'chat',
      content: 'Draft the agenda.',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    const { adapter, descriptor } = registry.resolve({
      transport: 'internal',
      agent_id: 'writer',
    });

    expect(adapter).toBe(internalTransportAdapter);
    expect(descriptor).toEqual({
      transport: 'internal',
      agentId: 'writer',
    });
    expect(adapter?.encode(envelope)).toEqual(envelope);
  });

  test('falls through when a transport has no registered adapter', () => {
    const registry = createDefaultTransportRegistry();

    const unregisteredKnown = registry.resolve({
      transport: 'a2a',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
    });
    const unknown = registry.resolve({ transport: 'smtp' });

    expect(unregisteredKnown.adapter).toBeNull();
    expect(unregisteredKnown.descriptor).toEqual({
      transport: 'a2a',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
    });
    expect(unknown.adapter).toBeNull();
    expect(unknown.descriptor).toEqual({
      transport: 'smtp',
      raw: { transport: 'smtp' },
    });
    expect(registry.resolveByTransport('webhook')).toBeNull();
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
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
      }),
    ).toThrow('secretRef is required');
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
        transport: 'webhook',
        url: 'https://hooks.example.com/a2a',
        secret_ref: { source: 'env', id: 'A2A_WEBHOOK_SECRET' },
      }),
    ).toEqual({
      transport: 'webhook',
      url: 'https://hooks.example.com/a2a',
      secretRef: { source: 'env', id: 'A2A_WEBHOOK_SECRET' },
    });
  });

  test('normalizes registered adapter transport keys', () => {
    const registry = createDefaultTransportRegistry();
    const adapter = {
      ...internalTransportAdapter,
      transport: ' Internal ',
    } as unknown as TransportAdapter;

    registry.register(adapter);

    expect(registry.resolveByTransport('internal')).toBe(adapter);
    expect(registry.resolveByTransport(' INTERNAL ')).toBe(adapter);
  });

  test('does not invoke non-internal adapters before delivery is implemented', () => {
    const registry = createDefaultTransportRegistry();
    let encodeCalled = false;
    registry.register({
      transport: 'a2a',
      encode(envelope) {
        encodeCalled = true;
        return envelope;
      },
    });
    const envelope = validateA2AEnvelope({
      id: 'msg-remote',
      sender_agent_id: 'main',
      recipient_agent_id: 'remote@team@peer-instance',
      thread_id: 'thread-remote',
      intent: 'chat',
      content: 'Can your peer agent receive this?',
      created_at: '2026-05-01T10:00:00.000Z',
    });

    expect(() =>
      encodeForRegisteredTransport({
        envelope,
        peerDescriptor: {
          transport: 'a2a',
          agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
        },
        registry,
      }),
    ).toThrow(TransportRegistryError);
    expect(encodeCalled).toBe(false);
  });
});
