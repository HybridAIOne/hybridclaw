import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-trust-ledger-');

function peerPublicKeyJwk() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'jwk' });
}

describe('A2A public-key trust ledger', () => {
  test('generates and persists one local instance keypair', async () => {
    const originalInstanceId = process.env.HYBRIDCLAW_INSTANCE_ID;
    process.env.HYBRIDCLAW_INSTANCE_ID = 'local-dev';
    try {
      const trust = await import('../src/a2a/trust-ledger.ts');

      const first = trust.ensureA2AInstanceKeypair(
        new Date('2030-01-01T00:00:00.000Z'),
      );
      const second = trust.ensureA2AInstanceKeypair(
        new Date('2030-01-02T00:00:00.000Z'),
      );

      expect(first.instanceId).toBe('local-dev');
      expect(second.publicKeyFingerprint).toBe(first.publicKeyFingerprint);
      expect(second.createdAt).toBe('2030-01-01T00:00:00.000Z');
      expect(first.publicKeyJwk).toMatchObject({
        kty: 'OKP',
        crv: 'Ed25519',
      });
    } finally {
      if (originalInstanceId === undefined) {
        delete process.env.HYBRIDCLAW_INSTANCE_ID;
      } else {
        process.env.HYBRIDCLAW_INSTANCE_ID = originalInstanceId;
      }
    }
  });

  test('records TOFU grants and operator revocations in audit', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const key = trust.extractA2APeerPublicKey({
      url: 'https://peer.example.com/a2a',
      hybridclaw: {
        instanceId: 'peer-prod',
        publicKeyJwk: peerPublicKeyJwk(),
      },
    });
    expect(key).not.toBeNull();
    if (!key) throw new Error('expected peer key material');

    const granted = trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer.example.com/a2a',
      key,
      runId: 'run-trust-grant',
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    expect(granted).toMatchObject({
      peerId: 'peer-prod',
      status: 'trusted',
      trustedAt: '2030-01-01T00:00:00.000Z',
    });

    const revoked = trust.revokeA2ATrustedPublicKeyPeer('peer-prod', {
      reason: 'rotating peer',
      runId: 'run-trust-revoke',
      now: new Date('2030-01-02T00:00:00.000Z'),
    });
    expect(revoked).toMatchObject({
      peerId: 'peer-prod',
      status: 'revoked',
      revokedReason: 'rotating peer',
    });

    const auditTypes = getRecentStructuredAuditForSession(
      'a2a:trust-ledger',
      10,
    ).map((entry) => entry.event_type);
    expect(auditTypes).toContain('a2a.trust.granted');
    expect(auditTypes).toContain('a2a.trust.revoked');
  });

  test('coalesces trusted peer last-seen refreshes', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const key = trust.extractA2APeerPublicKey({
      url: 'https://fresh-peer.example.com/a2a',
      hybridclaw: {
        instanceId: 'fresh-peer',
        publicKeyJwk: peerPublicKeyJwk(),
      },
    });
    expect(key).not.toBeNull();
    if (!key) throw new Error('expected peer key material');

    trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://fresh-peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://fresh-peer.example.com/a2a',
      key,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://fresh-peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://fresh-peer.example.com/a2a',
      key,
      now: new Date('2030-01-01T00:00:30.000Z'),
    });

    expect(trust.getA2ATrustedPublicKeyPeer('fresh-peer')).toMatchObject({
      lastSeenAt: '2030-01-01T00:00:00.000Z',
    });

    trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://fresh-peer.example.com/.well-known/agent.json',
      deliveryUrl: 'https://fresh-peer.example.com/a2a',
      key,
      now: new Date('2030-01-01T00:01:01.000Z'),
    });

    expect(trust.getA2ATrustedPublicKeyPeer('fresh-peer')).toMatchObject({
      lastSeenAt: '2030-01-01T00:01:01.000Z',
    });
  });

  test('allows operator pre-pinning by fingerprint before first contact', async () => {
    const { initDatabase, getRecentStructuredAuditForSession } = await import(
      '../src/memory/db.ts'
    );
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);

    const pinned = trust.upsertA2ATrustedPublicKeyPeer(
      {
        peerId: 'pinned-peer',
        agentCardUrl: 'https://pinned.example.com/.well-known/agent.json',
        deliveryUrl: 'https://pinned.example.com/a2a',
        publicKeyFingerprint,
        reason: 'out-of-band fingerprint',
      },
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(pinned).toMatchObject({
      peerId: 'pinned-peer',
      publicKeyJwk: null,
      publicKeyFingerprint,
      status: 'trusted',
    });

    const key = trust.extractA2APeerPublicKey({
      url: 'https://pinned.example.com/a2a',
      hybridclaw: {
        instanceId: 'pinned-peer',
        publicKeyJwk,
      },
    });
    expect(key).not.toBeNull();
    if (!key) throw new Error('expected peer key material');

    const hydrated = trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://pinned.example.com/.well-known/agent.json',
      deliveryUrl: 'https://pinned.example.com/a2a',
      key,
      now: new Date('2030-01-01T00:00:05.000Z'),
    });
    expect(hydrated.publicKeyJwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
    expect(hydrated.lastSeenAt).toBe('2030-01-01T00:00:05.000Z');

    const auditTypes = getRecentStructuredAuditForSession(
      'a2a:trust-ledger',
      10,
    ).map((entry) => entry.event_type);
    expect(auditTypes).toContain('a2a.trust.operator_override');
    expect(auditTypes).toContain('a2a.trust.pin_matched');
  });

  test('allows operator re-trust after revocation or rotation', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const firstKey = trust.extractA2APeerPublicKey({
      url: 'https://rotate.example.com/a2a',
      hybridclaw: {
        instanceId: 'rotating-peer',
        publicKeyJwk: peerPublicKeyJwk(),
      },
    });
    const secondKey = trust.extractA2APeerPublicKey({
      url: 'https://rotate.example.com/a2a',
      hybridclaw: {
        instanceId: 'rotating-peer',
        publicKeyJwk: peerPublicKeyJwk(),
      },
    });
    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBeNull();
    if (!firstKey || !secondKey) throw new Error('expected peer key material');

    trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://rotate.example.com/.well-known/agent.json',
      deliveryUrl: 'https://rotate.example.com/a2a',
      key: firstKey,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });
    trust.revokeA2ATrustedPublicKeyPeer('rotating-peer', {
      reason: 'rotation',
      now: new Date('2030-01-01T00:01:00.000Z'),
    });
    expect(() =>
      trust.assertA2APeerPublicKeyTrust({
        agentCardUrl: 'https://rotate.example.com/.well-known/agent.json',
        deliveryUrl: 'https://rotate.example.com/a2a',
        key: secondKey,
        now: new Date('2030-01-01T00:02:00.000Z'),
      }),
    ).toThrow('public key mismatch');

    const trusted = trust.upsertA2ATrustedPublicKeyPeer(
      {
        peerId: 'rotating-peer',
        agentCardUrl: 'https://rotate.example.com/.well-known/agent.json',
        deliveryUrl: 'https://rotate.example.com/a2a',
        publicKeyJwk: secondKey.publicKeyJwk,
        reason: 'accepted rotation',
      },
      new Date('2030-01-01T00:03:00.000Z'),
    );
    expect(trusted).toMatchObject({
      status: 'trusted',
      publicKeyFingerprint: secondKey.publicKeyFingerprint,
    });
    expect(trusted.revokedAt).toBeUndefined();
    expect(trusted.lastMismatchAt).toBeUndefined();

    expect(
      trust.assertA2APeerPublicKeyTrust({
        agentCardUrl: 'https://rotate.example.com/.well-known/agent.json',
        deliveryUrl: 'https://rotate.example.com/a2a',
        key: secondKey,
        now: new Date('2030-01-01T00:03:05.000Z'),
      }),
    ).toMatchObject({
      status: 'trusted',
      publicKeyFingerprint: secondKey.publicKeyFingerprint,
    });

    trust.deleteA2ATrustedPublicKeyPeer('rotating-peer');
    expect(trust.getA2ATrustedPublicKeyPeer('rotating-peer')).toBeNull();
  });
});
