import { describe, expect, test } from 'vitest';

import { setupA2AWebhookTestEnv } from './helpers/a2a-webhook-fixtures.ts';

setupA2AWebhookTestEnv('hc-a2a-identity-resolver-');

describe('A2A identity resolver', () => {
  test('resolves local canonical agents through deployment public URL and local public key', async () => {
    process.env.HYBRIDCLAW_INSTANCE_ID = 'inst-local';
    const { initDatabase } = await import('../src/memory/db.ts');
    const runtimeConfig = await import('../src/config/runtime-config.ts');
    const resolver = await import('../src/a2a/identity-resolver.ts');

    initDatabase({ quiet: true });
    runtimeConfig.updateRuntimeConfig((draft) => {
      draft.deployment.mode = 'local';
      draft.deployment.public_url = 'https://local-tunnel.example.com';
      draft.deployment.tunnel.provider = 'manual';
      draft.agents.list = [
        {
          id: 'main',
          canonicalId: 'main@team@inst-local',
          owner: 'team',
          role: 'lead',
        },
      ];
    });

    const resolved = await resolver.resolveA2AIdentity('main@team@inst-local');

    expect(resolved.url).toBe('https://local-tunnel.example.com');
    expect(JSON.parse(resolved.publicKey)).toMatchObject({
      kty: 'OKP',
      crv: 'Ed25519',
    });
  });

  test('invalidates cached trusted peer resolutions when trust records change', async () => {
    const { initDatabase } = await import('../src/memory/db.ts');
    const resolver = await import('../src/a2a/identity-resolver.ts');
    const trust = await import('../src/a2a/trust-ledger.ts');

    initDatabase({ quiet: true });
    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'peer-instance',
      agentCardUrl: 'https://peer-a.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer-a.example.com/a2a',
      publicKeyFingerprint: 'A'.repeat(43),
    });

    await expect(
      resolver.resolveA2AIdentity('remote@team@peer-instance'),
    ).resolves.toMatchObject({
      url: 'https://peer-a.example.com',
      publicKey: 'A'.repeat(43),
    });

    trust.upsertA2ATrustedPublicKeyPeer({
      peerId: 'peer-instance',
      agentCardUrl: 'https://peer-b.example.com/.well-known/agent.json',
      deliveryUrl: 'https://peer-b.example.com/a2a',
      publicKeyFingerprint: 'B'.repeat(43),
    });

    await expect(
      resolver.resolveA2AIdentity('remote@team@peer-instance'),
    ).resolves.toMatchObject({
      url: 'https://peer-b.example.com',
      publicKey: 'B'.repeat(43),
    });
  });
});
