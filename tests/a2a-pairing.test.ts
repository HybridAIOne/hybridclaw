import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-pairing-');

function peerPublicKeyJwk() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'jwk' });
}

describe('A2A operator pairing', () => {
  test('starts pairing from a peer URL and writes operator trust', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const peerKey = peerPublicKeyJwk();
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === 'https://peer.example.com/.well-known/agent.json') {
          return Response.json({
            name: 'Peer Instance',
            url: 'https://peer.example.com/a2a',
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: peerKey,
            },
          });
        }
        throw new Error(`unexpected ${init?.method || 'GET'} ${String(url)}`);
      },
    );

    const result = await pairing.startA2APairing({
      peerUrl: 'https://peer.example.com',
      notifyPeer: false,
      actor: 'admin-user',
      reason: 'pairing test',
      fetchImpl,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    expect(result.proposal).toMatchObject({
      peerId: 'peer-prod',
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      name: 'Peer Instance',
    });
    expect(result.remoteNotification).toMatchObject({
      status: 'not_requested',
    });
    expect(trust.getA2ATrustedPublicKeyPeer('peer-prod')).toMatchObject({
      status: 'trusted',
      trustedAt: '2030-01-01T00:00:00.000Z',
      publicKeyFingerprint: trust.fingerprintA2APublicKey(peerKey),
    });
    const overrideAudit = getRecentStructuredAuditForSession(
      'a2a:trust-ledger',
      10,
    )
      .map((entry) => JSON.parse(entry.payload || '{}'))
      .find((event) => event.type === 'a2a.trust.operator_override');
    expect(overrideAudit).toMatchObject({
      actor: 'admin-user',
      reason: 'pairing test',
      peerId: 'peer-prod',
    });
  });

  test('stores incoming pairing requests and approves them into trust', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);

    const request = pairing.createIncomingA2APairingRequest(
      {
        peerId: 'remote-prod',
        agentCardUrl: 'https://remote.example.com/.well-known/agent.json',
        deliveryUrl: 'https://remote.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
        requestedBy: 'remote-admin',
      },
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(request).toMatchObject({
      status: 'pending',
      peerId: 'remote-prod',
      requestedBy: 'remote-admin',
    });

    const approved = pairing.approveIncomingA2APairingRequest({
      requestId: request.requestId,
      actor: 'local-admin',
      reason: 'verified out of band',
      now: new Date('2030-01-01T00:01:00.000Z'),
    });
    expect(approved).toMatchObject({
      status: 'approved',
      approvedBy: 'local-admin',
    });
    expect(trust.getA2ATrustedPublicKeyPeer('remote-prod')).toMatchObject({
      status: 'trusted',
      publicKeyFingerprint,
    });
  });

  test('previews pairing by canonical instance id from trusted resolver data', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const peerKey = peerPublicKeyJwk();
    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'known-peer',
      agentCardUrl: 'https://known.example.com/.well-known/agent.json',
      deliveryUrl: 'https://known.example.com/a2a',
      publicKeyJwk: peerKey,
    });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        name: 'Known Peer',
        url: 'https://known.example.com/a2a',
        hybridclaw: {
          instanceId: 'known-peer',
          publicKeyJwk: peerKey,
        },
      }),
    );

    await expect(
      pairing.fetchA2APairingProposal({
        canonicalId: 'known-peer',
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      peerId: 'known-peer',
      name: 'Known Peer',
      publicKeyFingerprint: trust.fingerprintA2APublicKey(peerKey),
    });
  });
});
