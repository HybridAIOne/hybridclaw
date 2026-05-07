import { describe, expect, test } from 'vitest';

import {
  DnsIdentityResolverBackend,
  type DnsTxtLookup,
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
});
