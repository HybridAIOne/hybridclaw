import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-api-tokens-');

async function setupRegistry() {
  vi.resetModules();
  const dbPath = path.join(makeTempDir(), 'tokens.db');
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath });
  const tokens = await import('../src/security/api-tokens.ts');
  return { db, tokens };
}

describe('api token registry', () => {
  test('creates scoped hck tokens and stores only a verifier', async () => {
    const { db, tokens } = await setupRegistry();

    const result = tokens.createApiToken({
      label: 'SDK token',
      claims: { actions: ['openai.api'] },
      createdBy: 'tester',
    });

    expect(result.token).toMatch(/^hck_[a-f0-9]{12}_[A-Za-z0-9_-]+$/);
    expect(result.metadata).toMatchObject({
      label: 'SDK token',
      claims: { actions: ['openai.api'] },
      created_by: 'tester',
      revoked_at: null,
    });

    const row = db.withMemoryDatabase((database) =>
      database
        .prepare<
          [string],
          { token_hash: string; stored_token: string | null; claims: string }
        >(
          'SELECT token_hash, NULL AS stored_token, claims FROM api_tokens WHERE id = ?',
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

  test('verifies, lists, and throttles last-used writes', async () => {
    const { db, tokens } = await setupRegistry();
    const result = tokens.createApiToken({
      label: 'Chat sender',
      claims: { actions: ['chat.send'] },
    });

    const first = tokens.verifyApiToken(result.token, {
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = tokens.verifyApiToken(result.token, {
      now: new Date('2026-01-01T00:00:30.000Z'),
    });

    expect(first).toEqual({
      id: result.metadata.id,
      label: 'Chat sender',
      claims: { actions: ['chat.send'] },
    });
    expect(second).toEqual(first);
    expect(tokens.listApiTokens()).toHaveLength(1);

    const row = db.withMemoryDatabase((database) =>
      database
        .prepare<[string], { last_used_at: string | null }>(
          'SELECT last_used_at FROM api_tokens WHERE id = ?',
        )
        .get(result.metadata.id),
    );
    expect(row?.last_used_at).toBe('2026-01-01T00:00:00.000Z');
  });

  test('rejects revoked, expired, malformed, and mismatched tokens', async () => {
    const { tokens } = await setupRegistry();
    const active = tokens.createApiToken({
      label: 'Active',
      claims: { actions: ['openai.api'] },
    });
    const expired = tokens.createApiToken({
      label: 'Expired',
      claims: { actions: ['openai.api'] },
      expiresAt: '2025-01-01T00:00:00.000Z',
    });

    expect(tokens.verifyApiToken('not-a-token')).toBeNull();
    expect(tokens.verifyApiToken(`${active.token}x`)).toBeNull();
    expect(tokens.verifyApiToken(expired.token)).toBeNull();

    const revoked = tokens.revokeApiToken(active.metadata.id);
    expect(revoked?.revoked_at).toBeTruthy();
    expect(tokens.verifyApiToken(active.token)).toBeNull();
  });

  test('normalizes claimless records to deny-by-default payloads', async () => {
    const { tokens } = await setupRegistry();

    const result = tokens.createApiToken({
      label: 'No claims',
      claims: {},
    });

    expect(tokens.verifyApiToken(result.token)?.claims).toEqual({
      actions: [],
    });
  });

  test('prunes expired token rows when minting a new token', async () => {
    const { tokens } = await setupRegistry();
    const expired = tokens.createApiToken({
      label: 'Expired view token',
      claims: { actions: ['apps.view'], appIds: ['app-1'] },
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    expect(tokens.listApiTokens().map((token) => token.id)).toContain(
      expired.metadata.id,
    );

    const active = tokens.createApiToken({
      label: 'Active view token',
      claims: { actions: ['apps.view'], appIds: ['app-1'] },
    });

    expect(tokens.listApiTokens().map((token) => token.id)).toEqual([
      active.metadata.id,
    ]);
  });
});
