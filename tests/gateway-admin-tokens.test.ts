import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-admin-tokens-');

async function importAdminTokens() {
  vi.resetModules();
  const dbPath = path.join(makeTempDir(), 'tokens.db');
  const recordAuditEvent = vi.fn();
  const makeAuditRunId = vi.fn((prefix: string) => `${prefix}-run`);
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId,
    recordAuditEvent,
  }));

  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath });
  const service = await import('../src/gateway/gateway-admin-tokens.ts');
  const registry = await import('../src/security/api-tokens.ts');
  recordAuditEvent.mockClear();
  makeAuditRunId.mockClear();

  return {
    makeAuditRunId,
    recordAuditEvent,
    registry,
    service,
  };
}

describe('gateway admin API tokens', () => {
  useCleanMocks({
    resetModules: true,
    unmock: ['../src/audit/audit-events.js'],
  });

  test('creates a scoped token and audits metadata without the token value', async () => {
    const { recordAuditEvent, registry, service } = await importAdminTokens();

    const response = service.createGatewayAdminToken({
      body: {
        label: 'OpenAI SDK',
        actions: ['openai.api'],
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });

    expect(response.token).toMatch(/^hck_[a-f0-9]{12}_[A-Za-z0-9_-]+$/);
    expect(response.apiToken).toMatchObject({
      label: 'OpenAI SDK',
      claims: { actions: ['openai.api'] },
      created_by: 'admin-user',
      expires_at: '2027-01-01T00:00:00.000Z',
      revoked_at: null,
    });
    expect(registry.verifyApiToken(response.token)).toMatchObject({
      id: response.apiToken.id,
      label: 'OpenAI SDK',
      claims: { actions: ['openai.api'] },
    });
    expect(recordAuditEvent).toHaveBeenCalledWith({
      sessionId: 'admin-session-1',
      runId: 'token-create-run',
      event: {
        type: 'token.created',
        id: response.apiToken.id,
        label: 'OpenAI SDK',
        claims: { actions: ['openai.api'] },
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
      response.token,
    );
  });

  test('filters available actions and rejects claimless create requests', async () => {
    const { recordAuditEvent, service } = await importAdminTokens();

    expect(
      service.getGatewayAdminTokens({
        authPayload: { actions: ['admin.tokens.read'] },
      }).actions,
    ).toEqual(['admin.tokens.read']);
    expect(() =>
      service.createGatewayAdminToken({
        body: { label: 'No claims' },
        audit: { actor: 'admin-user' },
      }),
    ).toThrow('API token claims are required');
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('revokes tokens and audits only token metadata', async () => {
    const { recordAuditEvent, registry, service } = await importAdminTokens();
    const created = registry.createApiToken({
      label: 'Chat client',
      claims: { actions: ['chat.send'] },
    });

    const response = service.revokeGatewayAdminToken({
      id: created.metadata.id,
      audit: {
        sessionId: 'admin-session-1',
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });

    expect(response.apiToken).toMatchObject({
      id: created.metadata.id,
      label: 'Chat client',
      claims: { actions: ['chat.send'] },
    });
    expect(response.apiToken.revoked_at).toEqual(expect.any(String));
    expect(registry.verifyApiToken(created.token)).toBeNull();
    expect(recordAuditEvent).toHaveBeenCalledWith({
      sessionId: 'admin-session-1',
      runId: 'token-revoke-run',
      event: {
        type: 'token.revoked',
        id: created.metadata.id,
        label: 'Chat client',
        claims: { actions: ['chat.send'] },
        actor: 'admin-user',
        sourceIp: '127.0.0.1',
      },
    });
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
      created.token,
    );
  });
});
