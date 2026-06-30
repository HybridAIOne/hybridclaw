import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-trust-ledger-');

function peerPublicKeyJwk() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'jwk' });
}

function peerPublicKeyPem() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
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
        key: firstKey,
        now: new Date('2030-01-01T00:01:30.000Z'),
      }),
    ).toThrow(trust.A2APeerUntrustedError);
    expect(() =>
      trust.assertA2APeerPublicKeyTrust({
        agentCardUrl: 'https://rotate.example.com/.well-known/agent.json',
        deliveryUrl: 'https://rotate.example.com/a2a',
        key: secondKey,
        now: new Date('2030-01-01T00:02:00.000Z'),
      }),
    ).toThrow(trust.A2APeerUntrustedError);

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

describe('shared trusted peer ledger', () => {
  test('persists webhook peers on the shared trusted-peer substrate', async () => {
    const trust = await import('../src/a2a/trust-ledger.ts');

    const peer = trust.upsertA2ATrustedWebhookPeer(
      {
        peerId: 'zapier-prod',
        senderAgentId: 'remote@team@peer-instance',
        policyAuthority: 'org-admin',
        capabilities: ['POLICY.UPDATE', 'policy.update'],
        secretRef: { source: 'store', id: 'A2A_INBOUND_WEBHOOK_SECRET' },
        signatureHeader: 'x-hybridclaw-signature',
        rateLimitPerMinute: 12,
      },
      new Date('2030-02-01T00:00:00.000Z'),
    );

    expect(peer).toMatchObject({
      schemaVersion: 1,
      peerId: 'zapier-prod',
      senderAgentId: 'remote@team@peer-instance',
      policyAuthority: 'org_admin',
      capabilities: ['policy.update'],
      signatureHeader: 'x-hybridclaw-signature',
      rateLimitPerMinute: 12,
      createdAt: '2030-02-01T00:00:00.000Z',
      updatedAt: '2030-02-01T00:00:00.000Z',
    });

    const sharedPeer = trust.getSharedTrustedPeer('webhook', 'zapier-prod');
    expect(sharedPeer).toMatchObject({
      schemaVersion: 1,
      transport: 'webhook',
      peerId: 'zapier-prod',
      senderAgentId: 'remote@team@peer-instance',
      trust: {
        mode: 'operator',
        establishedAt: '2030-02-01T00:00:00.000Z',
        updatedAt: '2030-02-01T00:00:00.000Z',
      },
      auditLineage: {
        source: 'a2a-trust-ledger',
        origin: 'operator',
      },
      webhook: {
        signatureHeader: 'x-hybridclaw-signature',
        rateLimitPerMinute: 12,
      },
    });
    expect(trust.listSharedTrustedPeers('webhook')).toHaveLength(1);
    expect(trust.listA2ATrustedWebhookPeers()).toEqual([peer]);
  });

  test('migrates legacy webhook peers without breaking reads', async () => {
    const revisions = await import('../src/config/runtime-config-revisions.ts');
    const runtimePaths = await import('../src/config/runtime-paths.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');
    const legacyPath = path.join(
      runtimePaths.DEFAULT_RUNTIME_HOME_DIR,
      'a2a',
      'trust-ledger',
      'webhook',
      'legacy-zapier.json',
    );
    const legacyPeer = {
      schemaVersion: 1,
      peerId: 'legacy-zapier',
      senderAgentId: 'remote@team@peer-instance',
      capabilities: ['policy.update'],
      secretRef: { source: 'store', id: 'A2A_LEGACY_WEBHOOK_SECRET' },
      signatureHeader: 'x-legacy-signature',
      version: '1',
      replayWindowMs: 180_000,
      rateLimitPerMinute: 9,
      createdAt: '2030-03-01T00:00:00.000Z',
      updatedAt: '2030-03-02T00:00:00.000Z',
    };
    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      legacyPath,
      {
        route: 'test.legacy-webhook',
        source: 'test',
      },
      {
        exists: true,
        content: JSON.stringify(legacyPeer),
      },
    );

    expect(trust.getA2ATrustedWebhookPeer('legacy-zapier')).toMatchObject({
      peerId: 'legacy-zapier',
      senderAgentId: 'remote@team@peer-instance',
      signatureHeader: 'x-legacy-signature',
      replayWindowMs: 180_000,
      rateLimitPerMinute: 9,
      createdAt: '2030-03-01T00:00:00.000Z',
      updatedAt: '2030-03-02T00:00:00.000Z',
    });

    const sharedPeer = trust.getSharedTrustedPeer('webhook', 'legacy-zapier');
    expect(sharedPeer).toMatchObject({
      transport: 'webhook',
      peerId: 'legacy-zapier',
      trust: {
        mode: 'operator',
        establishedAt: '2030-03-01T00:00:00.000Z',
        updatedAt: '2030-03-02T00:00:00.000Z',
      },
      auditLineage: {
        source: 'a2a-trust-ledger',
        origin: 'legacy-webhook',
        legacyAssetPath: legacyPath,
      },
      webhook: {
        signatureHeader: 'x-legacy-signature',
        replayWindowMs: 180_000,
        rateLimitPerMinute: 9,
      },
    });
    expect(trust.listSharedTrustedPeers('webhook')).toEqual([sharedPeer]);
  });

  test('resolves A2A JSON-RPC peers from shared trusted-peer records', async () => {
    const trust = await import('../src/a2a/trust-ledger.ts');
    const publicKeyPem = peerPublicKeyPem();

    const peer = trust.upsertA2ATrustedA2APeer(
      {
        peerId: 'instance-b',
        senderAgentId: 'remote@team@inst-b',
        publicKeyPem,
        bearerTokenRef: { source: 'store', id: 'A2A_PEER_BEARER_TOKEN' },
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      },
      new Date('2030-04-01T00:00:00.000Z'),
    );

    expect(peer).toMatchObject({
      peerId: 'instance-b',
      senderAgentId: 'remote@team@inst-b',
      publicKeyPem,
    });
    const sharedPeer = trust.getSharedTrustedPeer('a2a', 'instance-b');
    expect(sharedPeer).toMatchObject({
      transport: 'a2a',
      peerId: 'instance-b',
      senderAgentId: 'remote@team@inst-b',
      a2a: {
        publicKeyPem,
        bearerTokenRef: {
          source: 'store',
          id: 'A2A_PEER_BEARER_TOKEN',
        },
        agentCardUrl: 'https://peer.example.com/.well-known/agent.json',
      },
    });
    expect(
      trust.getA2ATrustedA2APeerBySender('remote@team@inst-b'),
    ).toMatchObject({
      peerId: 'instance-b',
      publicKeyPem,
    });
    expect(trust.getA2ATrustedA2APeerByPublicKeyPem(publicKeyPem)).toMatchObject(
      {
        peerId: 'instance-b',
        senderAgentId: 'remote@team@inst-b',
      },
    );
  });

  test('mirrors public-key TOFU trust into shared A2A peer records', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');
    const publicKeyJwk = peerPublicKeyJwk();
    const key = {
      peerId: 'tofu-peer',
      publicKeyJwk,
      publicKeyFingerprint: trust.fingerprintA2APublicKey(publicKeyJwk),
    };

    initDatabase({ quiet: true });
    const trusted = trust.assertA2APeerPublicKeyTrust({
      agentCardUrl: 'https://tofu.example.com/.well-known/agent.json',
      deliveryUrl: 'https://tofu.example.com/a2a',
      key,
      now: new Date('2030-05-01T00:00:00.000Z'),
    });

    const sharedPeer = trust.getSharedTrustedPeer('a2a', 'tofu-peer');
    expect(sharedPeer).toMatchObject({
      transport: 'a2a',
      peerId: 'tofu-peer',
      trust: {
        mode: 'tofu',
        establishedAt: '2030-05-01T00:00:00.000Z',
      },
      auditLineage: {
        source: 'a2a-trust-ledger',
        origin: 'tofu',
      },
      a2a: {
        agentCardUrl: 'https://tofu.example.com/.well-known/agent.json',
        deliveryUrl: 'https://tofu.example.com/a2a',
        publicKeyFingerprint: trusted.publicKeyFingerprint,
        publicKeyStatus: 'trusted',
        trustedAt: '2030-05-01T00:00:00.000Z',
        lastSeenAt: '2030-05-01T00:00:00.000Z',
      },
    });
    expect(trust.getA2ATrustedPublicKeyPeer('tofu-peer')).toMatchObject({
      peerId: 'tofu-peer',
      publicKeyFingerprint: trusted.publicKeyFingerprint,
      status: 'trusted',
    });
  });

  test('migrates legacy public-key trust records into the shared ledger', async () => {
    const revisions = await import('../src/config/runtime-config-revisions.ts');
    const runtimePaths = await import('../src/config/runtime-paths.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const legacyPath = path.join(
      runtimePaths.DEFAULT_RUNTIME_HOME_DIR,
      'a2a',
      'trust-ledger',
      'public-key',
      'legacy-public-key.json',
    );
    const legacyPeer = {
      schemaVersion: 1,
      peerId: 'legacy-public-key',
      agentCardUrl: 'https://legacy-key.example.com/.well-known/agent.json',
      deliveryUrl: 'https://legacy-key.example.com/a2a',
      publicKeyJwk,
      publicKeyFingerprint,
      status: 'trusted',
      trustedAt: '2030-06-01T00:00:00.000Z',
      createdAt: '2030-06-01T00:00:00.000Z',
      updatedAt: '2030-06-01T00:00:00.000Z',
      lastSeenAt: '2030-06-01T00:00:00.000Z',
    };
    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      legacyPath,
      {
        route: 'test.legacy-public-key',
        source: 'test',
      },
      {
        exists: true,
        content: JSON.stringify(legacyPeer),
      },
    );

    expect(trust.getA2ATrustedPublicKeyPeer('legacy-public-key')).toMatchObject({
      peerId: 'legacy-public-key',
      publicKeyFingerprint,
      status: 'trusted',
    });
    expect(trust.getSharedTrustedPeer('a2a', 'legacy-public-key')).toMatchObject({
      transport: 'a2a',
      peerId: 'legacy-public-key',
      auditLineage: {
        origin: 'tofu',
        legacyAssetPath: legacyPath,
      },
      a2a: {
        publicKeyFingerprint,
        publicKeyStatus: 'trusted',
      },
    });
  });

  test('merges legacy A2A JSON-RPC records into existing shared A2A peers', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const revisions = await import('../src/config/runtime-config-revisions.ts');
    const runtimePaths = await import('../src/config/runtime-paths.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const publicKeyPem = peerPublicKeyPem();
    const legacyPath = path.join(
      runtimePaths.DEFAULT_RUNTIME_HOME_DIR,
      'a2a',
      'trust-ledger',
      'a2a',
      'merged-peer.json',
    );

    initDatabase({ quiet: true });
    trust.upsertA2ATrustedPublicKeyPeer(
      {
        peerId: 'merged-peer',
        agentCardUrl: 'https://merged.example.com/.well-known/agent.json',
        deliveryUrl: 'https://merged.example.com/a2a',
        publicKeyJwk,
      },
      new Date('2030-07-01T00:00:00.000Z'),
    );
    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      legacyPath,
      {
        route: 'test.legacy-a2a',
        source: 'test',
      },
      {
        exists: true,
        content: JSON.stringify({
          schemaVersion: 1,
          peerId: 'merged-peer',
          senderAgentId: 'remote@team@merged-instance',
          publicKeyPem,
          createdAt: '2030-07-02T00:00:00.000Z',
          updatedAt: '2030-07-02T00:00:00.000Z',
        }),
      },
    );

    expect(
      trust.getSharedTrustedA2AJsonRpcPeerBySender(
        'remote@team@merged-instance',
      ),
    ).toMatchObject({
      peerId: 'merged-peer',
      senderAgentId: 'remote@team@merged-instance',
      a2a: {
        publicKeyPem,
        publicKeyFingerprint,
        publicKeyStatus: 'trusted',
      },
    });
    expect(trust.getSharedTrustedPeer('a2a', 'merged-peer')).toMatchObject({
      transport: 'a2a',
      peerId: 'merged-peer',
      a2a: {
        publicKeyPem,
        publicKeyFingerprint,
      },
    });
  });
});
