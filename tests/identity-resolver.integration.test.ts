import { describe, expect, test } from 'vitest';

import {
  DnsIdentityResolverBackend,
  type DnsTxtLookup,
  getDefaultIdentityResolver,
  IDENTITY_DISCOVERY_ZONE_ENV,
  IdentityNotFoundError,
  IdentityResolver,
  IdentityResolverError,
  identityDiscoveryDnsName,
  parseCanonicalIdentity,
} from '../src/identity/resolver.js';

describe('identity resolver discovery', () => {
  test('normalizes canonical user and agent ids', () => {
    expect(parseCanonicalIdentity(' Ada@HybridAI ')).toMatchObject({
      kind: 'user',
      id: 'ada@hybridai',
    });
    expect(
      parseCanonicalIdentity(' Support-Lena@Acme@Inst-7F3A '),
    ).toMatchObject({
      kind: 'agent',
      id: 'support-lena@acme@inst-7f3a',
    });
  });

  test('resolves canonical ids through DNS-style TXT records', async () => {
    const zone = 'identity.example.com';
    const canonicalId = 'Support-Lena@Acme@Inst-7F3A';
    const recordName = identityDiscoveryDnsName(canonicalId, zone);
    const lookupTxt: DnsTxtLookup = async (name) => {
      expect(name).toBe(recordName);
      return [
        [
          JSON.stringify({
            canonicalId: 'support-lena@acme@inst-7f3a',
            url: 'https://bot.example.com/',
            publicKey: 'test-public-key',
          }),
        ],
      ];
    };
    const resolver = new IdentityResolver({
      backend: new DnsIdentityResolverBackend({ zone, lookupTxt }),
    });

    await expect(resolver.resolve(canonicalId)).resolves.toEqual({
      url: 'https://bot.example.com',
      publicKey: 'test-public-key',
    });
  });

  test('caches DNS-style lookup results and supports explicit invalidation', async () => {
    const zone = 'identity.example.com';
    const canonicalId = 'ada@hybridai';
    const recordName = identityDiscoveryDnsName(canonicalId, zone);
    let nowMs = Date.parse('2026-05-07T10:00:00.000Z');
    let lookupCount = 0;
    let currentPublicKey = 'first-key';
    const lookupTxt: DnsTxtLookup = async (name) => {
      expect(name).toBe(recordName);
      lookupCount += 1;
      return [
        [
          JSON.stringify({
            canonicalId,
            url: 'https://ada.example.com',
            publicKey: currentPublicKey,
          }),
        ],
      ];
    };
    const resolver = new IdentityResolver({
      backend: new DnsIdentityResolverBackend({ zone, lookupTxt }),
      cacheTtlMs: 60_000,
      now: () => new Date(nowMs),
    });

    await expect(resolver.resolve('Ada@HybridAI')).resolves.toEqual({
      url: 'https://ada.example.com',
      publicKey: 'first-key',
    });
    currentPublicKey = 'second-key';
    await expect(resolver.resolve(canonicalId)).resolves.toEqual({
      url: 'https://ada.example.com',
      publicKey: 'first-key',
    });
    expect(lookupCount).toBe(1);

    resolver.invalidate(canonicalId);

    await expect(resolver.resolve(canonicalId)).resolves.toEqual({
      url: 'https://ada.example.com',
      publicKey: 'second-key',
    });
    expect(lookupCount).toBe(2);

    currentPublicKey = 'third-key';
    nowMs += 60_001;

    await expect(resolver.resolve(canonicalId)).resolves.toEqual({
      url: 'https://ada.example.com',
      publicKey: 'third-key',
    });
    expect(lookupCount).toBe(3);
  });

  test('rejects invalid cache configuration instead of clamping', () => {
    expect(
      () =>
        new IdentityResolver({
          backend: {
            async lookup() {
              return null;
            },
          },
          cacheTtlMs: 0,
        }),
    ).toThrow(IdentityResolverError);
    expect(
      () =>
        new IdentityResolver({
          backend: {
            async lookup() {
              return null;
            },
          },
          cacheMaxEntries: -1,
        }),
    ).toThrow(IdentityResolverError);
  });

  test('evicts old cache entries when the cache reaches its max size', async () => {
    let lookupCount = 0;
    const resolver = new IdentityResolver({
      backend: {
        async lookup(canonicalId) {
          lookupCount += 1;
          return {
            url: `https://${canonicalId.replace('@', '.')}.example.com`,
            publicKey: `key-for-${canonicalId}`,
          };
        },
      },
      cacheMaxEntries: 2,
    });

    await resolver.resolve('ada@hybridai');
    await resolver.resolve('grace@hybridai');
    await resolver.resolve('linus@hybridai');

    await expect(resolver.resolve('ada@hybridai')).resolves.toEqual({
      url: 'https://ada.hybridai.example.com',
      publicKey: 'key-for-ada@hybridai',
    });
    expect(lookupCount).toBe(4);
  });

  test('deduplicates concurrent cold-cache lookups for the same identity', async () => {
    let lookupCount = 0;
    let releaseLookup!: (value: { url: string; publicKey: string }) => void;
    const lookupGate = new Promise<{ url: string; publicKey: string }>(
      (resolve) => {
        releaseLookup = resolve;
      },
    );
    const resolver = new IdentityResolver({
      backend: {
        async lookup() {
          lookupCount += 1;
          return lookupGate;
        },
      },
    });

    const first = resolver.resolve('ada@hybridai');
    const second = resolver.resolve('Ada@HybridAI');
    releaseLookup({
      url: 'https://ada.example.com',
      publicKey: 'test-public-key',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        url: 'https://ada.example.com',
        publicKey: 'test-public-key',
      },
      {
        url: 'https://ada.example.com',
        publicKey: 'test-public-key',
      },
    ]);
    expect(lookupCount).toBe(1);
  });

  test('skips malformed DNS TXT records when another record is usable', async () => {
    const zone = 'identity.example.com';
    const canonicalId = 'ada@hybridai';
    const resolver = new IdentityResolver({
      backend: new DnsIdentityResolverBackend({
        zone,
        lookupTxt: async () => [
          ['not-json'],
          [
            JSON.stringify({
              canonicalId,
              url: 'https://ada.example.com',
              publicKey: 'test-public-key',
            }),
          ],
        ],
      }),
    });

    await expect(resolver.resolve(canonicalId)).resolves.toEqual({
      url: 'https://ada.example.com',
      publicKey: 'test-public-key',
    });
  });

  test('requires canonicalId in DNS TXT records', async () => {
    const resolver = new IdentityResolver({
      backend: new DnsIdentityResolverBackend({
        zone: 'identity.example.com',
        lookupTxt: async () => [
          [
            JSON.stringify({
              url: 'https://ada.example.com',
              publicKey: 'test-public-key',
            }),
          ],
        ],
      }),
    });

    await expect(resolver.resolve('ada@hybridai')).rejects.toThrow(
      IdentityNotFoundError,
    );
  });

  test('reports DNS TXT record context when no record is usable', async () => {
    const resolver = new IdentityResolver({
      backend: new DnsIdentityResolverBackend({
        zone: 'identity.example.com',
        lookupTxt: async () => [['not-json']],
      }),
    });

    await expect(resolver.resolve('ada@hybridai')).rejects.toThrow(
      /No usable identity discovery TXT record for ada@hybridai at _hybridclaw-id\./u,
    );
  });

  test('does not cache misses', async () => {
    let lookupCount = 0;
    const resolver = new IdentityResolver({
      backend: {
        async lookup() {
          lookupCount += 1;
          return null;
        },
      },
    });

    await expect(resolver.resolve('missing@hybridai')).rejects.toThrow(
      IdentityNotFoundError,
    );
    await expect(resolver.resolve('missing@hybridai')).rejects.toThrow(
      IdentityNotFoundError,
    );
    expect(lookupCount).toBe(2);
  });

  test('rejects insecure non-loopback discovery URLs', async () => {
    const resolver = new IdentityResolver({
      backend: {
        async lookup() {
          return {
            url: 'http://peer.example.com',
            publicKey: 'test-public-key',
          };
        },
      },
    });

    await expect(resolver.resolve('ada@hybridai')).rejects.toThrow(
      IdentityResolverError,
    );
  });

  test('caches default resolver by normalized discovery zone', () => {
    const originalZone = process.env[IDENTITY_DISCOVERY_ZONE_ENV];
    try {
      process.env[IDENTITY_DISCOVERY_ZONE_ENV] = 'Identity.Test.';
      const first = getDefaultIdentityResolver();
      process.env[IDENTITY_DISCOVERY_ZONE_ENV] = 'identity.test';
      const second = getDefaultIdentityResolver();

      expect(first).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      if (originalZone === undefined) {
        delete process.env[IDENTITY_DISCOVERY_ZONE_ENV];
      } else {
        process.env[IDENTITY_DISCOVERY_ZONE_ENV] = originalZone;
      }
    }
  });
});
