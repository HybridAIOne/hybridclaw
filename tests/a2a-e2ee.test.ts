import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-e2ee-');

function envelope(id: string) {
  return {
    id,
    sender_agent_id: 'sender@team@instance-a',
    recipient_agent_id: 'receiver@team@instance-b',
    sender_instance_id: 'instance-a',
    thread_id: 'thread-e2ee',
    intent: 'chat',
    content: `confidential ${id}`,
    created_at: '2030-01-01T00:00:00.000Z',
  } as const;
}

describe('A2A E2EE', () => {
  test('persists a separate X25519 keypair with private file permissions', async () => {
    const e2ee = await import('../src/a2a/e2ee.ts');

    const first = e2ee.ensureA2AE2EEKeypair(
      new Date('2030-01-01T00:00:00.000Z'),
    );
    const second = e2ee.ensureA2AE2EEKeypair(
      new Date('2030-01-02T00:00:00.000Z'),
    );

    expect(first.publicKeyJwk).toMatchObject({ kty: 'OKP', crv: 'X25519' });
    expect(first.privateKeyJwk).toMatchObject({
      kty: 'OKP',
      crv: 'X25519',
      d: expect.any(String),
    });
    expect(second.publicKeyFingerprint).toBe(first.publicKeyFingerprint);
    const keyPath = path.join(
      process.env.HYBRIDCLAW_DATA_DIR || '',
      'a2a',
      'e2ee-keypair.json',
    );
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  test('encrypts content, binds routing metadata, and decrypts for the local key', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const e2ee = await import('../src/a2a/e2ee.ts');
    initDatabase({ quiet: true });
    const advertisement = e2ee.getLocalA2AE2EEAdvertisement();
    const peer = e2ee.trustA2AE2EEPeer({
      peerId: 'instance-b',
      advertisement,
      now: new Date('2030-01-01T00:00:00.000Z'),
    });

    const encrypted = await e2ee.encryptA2AEnvelopeForPeer(
      envelope('message-1'),
      peer,
    );

    expect(encrypted.content).not.toContain('confidential message-1');
    expect(encrypted.content.split('.')).toHaveLength(5);
    expect(encrypted.encryption).toMatchObject({
      version: 'jwe-x25519-a256gcm-v1',
      alg: 'ECDH-ES',
      enc: 'A256GCM',
      kid: advertisement.keyId,
    });
    expect(e2ee.digestA2ATransportEnvelope(encrypted)).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    await expect(
      e2ee.decryptA2AEnvelope(encrypted, { required: true }),
    ).resolves.toEqual(envelope('message-1'));

    const delegated = {
      ...envelope('message-delegated'),
      source_instance_id: 'instance-a',
      target_instance_id: 'instance-b',
      delegation_token: 'jwt.header.payload',
    } as const;
    const encryptedDelegated = await e2ee.encryptA2AEnvelopeForPeer(
      delegated,
      peer,
    );
    expect(encryptedDelegated).not.toHaveProperty('delegation_token');
    expect(encryptedDelegated).not.toHaveProperty('source_instance_id');
    expect(encryptedDelegated).not.toHaveProperty('target_instance_id');
    await expect(
      e2ee.decryptA2AEnvelope(encryptedDelegated, { required: true }),
    ).resolves.toEqual(delegated);
  });

  test('rejects metadata tampering, ciphertext tampering, and plaintext downgrade', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const e2ee = await import('../src/a2a/e2ee.ts');
    initDatabase({ quiet: true });
    const peer = e2ee.trustA2AE2EEPeer({
      peerId: 'instance-b',
      advertisement: e2ee.getLocalA2AE2EEAdvertisement(),
    });
    const encrypted = await e2ee.encryptA2AEnvelopeForPeer(
      envelope('message-2'),
      peer,
    );

    await expect(
      e2ee.decryptA2AEnvelope(
        { ...encrypted, recipient_agent_id: 'other@team@instance-b' },
        { required: true },
      ),
    ).rejects.toThrow('metadata binding failed');
    const segments = encrypted.content.split('.');
    const ciphertext = segments[3] ?? '';
    segments[3] = `${ciphertext.startsWith('A') ? 'B' : 'A'}${ciphertext.slice(1)}`;
    await expect(
      e2ee.decryptA2AEnvelope(
        { ...encrypted, content: segments.join('.') },
        { required: true },
      ),
    ).rejects.toThrow('decryption failed');
    await expect(
      e2ee.decryptA2AEnvelope(envelope('message-2'), { required: true }),
    ).rejects.toThrow('E2EE is required');
  });

  test('rejects private material and key fingerprint mismatches in advertisements', async () => {
    const e2ee = await import('../src/a2a/e2ee.ts');
    const advertisement = e2ee.getLocalA2AE2EEAdvertisement();

    expect(() =>
      e2ee.parseA2AE2EEAdvertisement({
        ...advertisement,
        publicKeyJwk: {
          ...advertisement.publicKeyJwk,
          d: 'private-material',
        },
      }),
    ).toThrow('must not include private key material');
    expect(() =>
      e2ee.parseA2AE2EEAdvertisement({
        ...advertisement,
        publicKeyFingerprint: 'A'.repeat(43),
      }),
    ).toThrow('does not match publicKeyJwk');
  });

  test('fails closed when a pinned peer record is corrupt', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const revisions = await import(
      '../src/config/runtime-config-revisions.ts'
    );
    const e2ee = await import('../src/a2a/e2ee.ts');
    initDatabase({ quiet: true });
    const assetPath = path.join(
      process.env.HYBRIDCLAW_DATA_DIR || '',
      'a2a',
      'e2ee-peers',
      'instance-b.json',
    );
    revisions.syncRuntimeAssetRevisionState(
      'a2a',
      assetPath,
      { route: 'test.corrupt-e2ee-peer', source: 'internal' },
      { exists: true, content: '{not-json' },
    );

    expect(() => e2ee.getA2ATrustedE2EEPeer('instance-b')).toThrow();
  });
});
