import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-app-publications-');

async function setupRegistry() {
  vi.resetModules();
  const dbPath = path.join(makeTempDir(), 'publications.db');
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath });
  const publications = await import('../src/security/app-publications.ts');
  return { db, publications };
}

describe('app publication registry', () => {
  test('creates hcp tokens and stores only a scrypt verifier', async () => {
    const { db, publications } = await setupRegistry();

    const result = publications.createPublication({
      appId: 'app-1',
      policy: { kind: 'link' },
      embedHosts: ['https://example.com/widget'],
      label: 'Website embed',
      createdBy: 'tester',
    });

    expect(result.token).toMatch(/^hcp_[a-f0-9]{12}_[A-Za-z0-9_-]+$/);
    expect(result.metadata).toMatchObject({
      appId: 'app-1',
      policy: { kind: 'link' },
      embedHosts: ['https://example.com'],
      label: 'Website embed',
      created_by: 'tester',
      revoked_at: null,
    });

    const row = db.withMemoryDatabase((database) =>
      database
        .prepare<
          [string],
          { token_hash: string; stored_token: string | null; policy: string }
        >(
          'SELECT token_hash, NULL AS stored_token, policy FROM app_publications WHERE id = ?',
        )
        .get(result.metadata.id),
    );

    expect(row?.stored_token).toBeNull();
    expect(row?.token_hash).toMatch(
      /^scrypt:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    );
    expect(row?.token_hash).not.toBe(result.token);
    expect(JSON.stringify(row)).not.toContain(result.token);
  });

  test('verifies, lists, revokes, and prunes publication tokens', async () => {
    const { publications } = await setupRegistry();
    const active = publications.createPublication({
      appId: 'app-1',
      policy: { kind: 'link' },
    });
    const expired = publications.createPublication({
      appId: 'app-1',
      policy: { kind: 'link' },
      expiresAt: '2025-01-01T00:00:00.000Z',
    });

    expect(publications.verifyPublicationToken('not-a-token')).toEqual({
      status: 'malformed',
    });
    expect(publications.verifyPublicationToken(`${active.token}x`)).toEqual({
      status: 'missing',
    });
    expect(publications.verifyPublicationToken(expired.token)).toEqual({
      status: 'expired',
    });
    expect(
      publications.verifyPublicationToken(active.token, {
        now: new Date('2026-01-01T00:00:00.000Z'),
      }),
    ).toMatchObject({
      status: 'ok',
      publication: { id: active.metadata.id, appId: 'app-1' },
    });

    expect(publications.listPublicationsForApp('app-1')).toHaveLength(2);
    expect(publications.prunePublications()).toBeGreaterThanOrEqual(1);
    expect(
      publications
        .listPublicationsForApp('app-1')
        .map((publication) => publication.id),
    ).toEqual([active.metadata.id]);

    const revoked = publications.revokePublication(active.metadata.id);
    expect(revoked?.revoked_at).toBeTruthy();
    expect(publications.verifyPublicationToken(active.token)).toEqual({
      status: 'revoked',
    });
  });

  test('uses the shared scrypt verifier for password policies', async () => {
    const { db, publications } = await setupRegistry();
    const policy = publications.createPasswordPublicationPolicy('correct horse');
    const result = publications.createPublication({
      appId: 'app-1',
      policy,
    });

    expect(publications.isPublicationPasswordMatch(policy, 'correct horse')).toBe(
      true,
    );
    expect(publications.isPublicationPasswordMatch(policy, 'wrong horse')).toBe(
      false,
    );

    const row = db.withMemoryDatabase((database) =>
      database
        .prepare<[string], { policy: string }>(
          'SELECT policy FROM app_publications WHERE id = ?',
        )
        .get(result.metadata.id),
    );
    const storedPolicy = JSON.parse(row?.policy || '{}') as { hash?: string };
    expect(storedPolicy.hash).toMatch(
      /^scrypt:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/,
    );
    expect(storedPolicy.hash).not.toContain('correct horse');
  });
});
