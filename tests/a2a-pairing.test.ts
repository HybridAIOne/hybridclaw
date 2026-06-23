import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-pairing-');

function peerPublicKeyJwk() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'jwk' });
}

function peerDelegationPublicKeyPem() {
  const pair = generateKeyPairSync('ed25519');
  return pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

function makePairingRequest(params: {
  body: unknown;
  remoteAddress?: string;
}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(params.body))]), {
    method: 'POST',
    socket: {
      remoteAddress: params.remoteAddress || '203.0.113.10',
    },
  });
}

function makePairingResponse() {
  const headers = new Map<string, string>();
  return {
    statusCode: 0,
    body: '',
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
    },
    end(body?: string) {
      this.body = body || '';
    },
  };
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
    const delegationPublicKeyPem = peerDelegationPublicKeyPem();
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url) === 'https://peer.example.com/.well-known/agent.json') {
          return Response.json({
            name: 'Peer Instance',
            url: 'https://peer.example.com/a2a',
            agents: [{ id: 'remote@team@peer-prod' }],
            hybridclaw: {
              instanceId: 'peer-prod',
              publicKeyJwk: peerKey,
              delegation: {
                algorithm: 'Ed25519',
                publicKeyPem: delegationPublicKeyPem,
                senderAgentIds: ['remote@team@peer-prod'],
              },
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
    expect(
      trust.getA2ATrustedA2APeerBySender('remote@team@peer-prod'),
    ).toMatchObject({
      senderAgentId: 'remote@team@peer-prod',
      publicKeyPem: delegationPublicKeyPem,
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
    const delegationPublicKeyPem = peerDelegationPublicKeyPem();

    const request = pairing.createIncomingA2APairingRequest(
      {
        peerId: 'remote-prod',
        agentCardUrl: 'https://remote.example.com/.well-known/agent.json',
        deliveryUrl: 'https://remote.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
        delegation: {
          algorithm: 'Ed25519',
          publicKeyPem: delegationPublicKeyPem,
          senderAgentIds: ['remote@team@remote-prod'],
        },
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
    expect(
      trust.getA2ATrustedA2APeerBySender('remote@team@remote-prod'),
    ).toMatchObject({
      senderAgentId: 'remote@team@remote-prod',
      publicKeyPem: delegationPublicKeyPem,
    });
  });

  test('keeps terminal pairing request URLs immutable on replay', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const request = pairing.createIncomingA2APairingRequest(
      {
        peerId: 'stable-prod',
        agentCardUrl: 'https://stable.example.com/.well-known/agent.json',
        deliveryUrl: 'https://stable.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
      },
      new Date('2030-01-01T00:00:00.000Z'),
    );
    const approved = pairing.approveIncomingA2APairingRequest({
      requestId: request.requestId,
      actor: 'local-admin',
      now: new Date('2030-01-01T00:01:00.000Z'),
    });

    const replayed = pairing.createIncomingA2APairingRequest(
      {
        peerId: 'stable-prod',
        agentCardUrl: 'https://attacker.example.com/.well-known/agent.json',
        deliveryUrl: 'https://attacker.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
      },
      new Date('2030-01-01T00:02:00.000Z'),
    );

    expect(replayed).toMatchObject({
      status: 'approved',
      agentCardUrl: approved.agentCardUrl,
      deliveryUrl: approved.deliveryUrl,
      updatedAt: approved.updatedAt,
    });
  });

  test('rejects approve or decline on terminal pairing requests', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const request = pairing.createIncomingA2APairingRequest({
      peerId: 'terminal-prod',
      agentCardUrl: 'https://terminal.example.com/.well-known/agent.json',
      deliveryUrl: 'https://terminal.example.com/a2a',
      publicKeyJwk,
      publicKeyFingerprint,
    });
    pairing.declineIncomingA2APairingRequest({
      requestId: request.requestId,
      actor: 'local-admin',
    });

    expect(() =>
      pairing.approveIncomingA2APairingRequest({
        requestId: request.requestId,
        actor: 'local-admin',
      }),
    ).toThrow('Pairing request is already in a terminal state.');
    expect(() =>
      pairing.declineIncomingA2APairingRequest({
        requestId: request.requestId,
        actor: 'local-admin',
      }),
    ).toThrow('Pairing request is already in a terminal state.');
  });

  test('rejects oversized peer-supplied pairing display fields', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);

    expect(() =>
      pairing.createIncomingA2APairingRequest({
        peerId: 'large-field-prod',
        agentCardUrl: 'https://large-field.example.com/.well-known/agent.json',
        deliveryUrl: 'https://large-field.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
        name: 'x'.repeat(513),
      }),
    ).toThrow('name must be 512 characters or fewer.');
  });

  test('rate limits the public inbound pairing endpoint per remote address', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const body = {
      peerId: 'rate-prod',
      agentCardUrl: 'https://rate.example.com/.well-known/agent.json',
      deliveryUrl: 'https://rate.example.com/a2a',
      publicKeyJwk,
      publicKeyFingerprint,
    };
    const url = new URL('https://local.example.com/a2a/pairing/requests');

    for (let index = 0; index < 30; index += 1) {
      const res = makePairingResponse();
      await pairing.handleA2APairingRequestInbound(
        makePairingRequest({ body }),
        res as never,
        url,
      );
      expect(res.statusCode).toBe(202);
    }

    const limited = makePairingResponse();
    await pairing.handleA2APairingRequestInbound(
      makePairingRequest({ body }),
      limited as never,
      url,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.getHeader('Retry-After')).toBeTruthy();
  });

  test('rejects stored pairing requests with mismatched deterministic request ids', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const { DEFAULT_RUNTIME_HOME_DIR } = await import(
      '../src/config/runtime-paths.ts'
    );
    const { syncRuntimeAssetRevisionState } = await import(
      '../src/config/runtime-config-revisions.ts'
    );
    const pairing = await import('../src/a2a/pairing.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    const publicKeyJwk = peerPublicKeyJwk();
    const publicKeyFingerprint = trust.fingerprintA2APublicKey(publicKeyJwk);
    const request = pairing.createIncomingA2APairingRequest(
      {
        peerId: 'tampered-prod',
        agentCardUrl: 'https://tampered.example.com/.well-known/agent.json',
        deliveryUrl: 'https://tampered.example.com/a2a',
        publicKeyJwk,
        publicKeyFingerprint,
      },
      new Date('2030-01-01T00:00:00.000Z'),
    );
    const assetPath = path.join(
      DEFAULT_RUNTIME_HOME_DIR,
      'a2a',
      'pairing',
      'requests',
      `${encodeURIComponent(request.requestId)}.json`,
    );
    syncRuntimeAssetRevisionState(
      'a2a',
      assetPath,
      {
        route: `a2a.pairing.request#${request.requestId}`,
        source: 'a2a-pairing',
      },
      {
        exists: true,
        content: JSON.stringify({ ...request, requestId: 'tampered' }),
      },
    );

    expect(() =>
      pairing.approveIncomingA2APairingRequest({
        requestId: request.requestId,
        actor: 'local-admin',
      }),
    ).toThrow('A2A pairing request not found.');
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

  test('skips malformed DNS TXT records while resolving canonical instance ids', async () => {
    const peerKey = peerPublicKeyJwk();
    vi.doMock('node:dns/promises', () => ({
      resolveTxt: vi.fn(async () => [
        ['{not json'],
        [
          JSON.stringify({
            instanceId: 'dns-peer',
            url: 'https://dns.example.com',
            publicKey: JSON.stringify(peerKey),
          }),
        ],
      ]),
    }));
    process.env.HYBRIDCLAW_IDENTITY_DISCOVERY_ZONE = 'example.test';
    const { initDatabase } = await import('../src/memory/db.ts');
    const pairing = await import('../src/a2a/pairing.ts');

    initDatabase({ quiet: true });
    const fetchImpl = vi.fn(async () =>
      Response.json({
        name: 'DNS Peer',
        url: 'https://dns.example.com/a2a',
        hybridclaw: {
          instanceId: 'dns-peer',
          publicKeyJwk: peerKey,
        },
      }),
    );

    await expect(
      pairing.fetchA2APairingProposal({
        canonicalId: 'dns-peer',
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      peerId: 'dns-peer',
      agentCardUrl: 'https://dns.example.com/.well-known/agent.json',
    });
  });
});
