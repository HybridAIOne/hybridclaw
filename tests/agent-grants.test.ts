import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-agent-grants-',
});

async function setupGrantStore() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  db.upsertAgent({ id: 'lexware', name: 'Lexware' });
  const grants = await import('../src/agents/agent-grants.js');
  const sharing = await import('../src/agents/agent-sharing.js');
  return { db, grants, sharing };
}

describe('agent grants', () => {
  test('migrates a version 51 database without a sharing table or flag', async () => {
    const homeDir = setupHome();
    const dbPath = path.join(homeDir, 'hybridclaw-v51.db');
    const db = await import('../src/memory/db.js');
    db.initDatabase({ quiet: true, dbPath });
    db.withMemoryDatabase((database) => {
      database.exec(`
        DROP INDEX idx_agent_grants_principal;
        DROP TABLE agent_grants;
        ALTER TABLE agents DROP COLUMN shared;
        DELETE FROM migrations WHERE version = 52;
      `);
      database.pragma('user_version = 51');
      database.close();
    });

    db.initDatabase({ quiet: true, dbPath });

    const state = db.withMemoryDatabase((database) => ({
      version: Number(database.pragma('user_version', { simple: true })),
      sharedColumn: database
        .prepare<[], { name: string }>('PRAGMA table_info(agents)')
        .all()
        .some((column) => column.name === 'shared'),
      grantsTable: database
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_grants'",
        )
        .get()?.name,
    }));
    expect(state).toEqual({
      version: db.DATABASE_SCHEMA_VERSION,
      sharedColumn: true,
      grantsTable: 'agent_grants',
    });
  });

  test('persists every Phase 2 field and normalizes principals once', async () => {
    const { db, grants } = await setupGrantStore();

    const grant = grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: ' User_A@HybridAI.One ',
      source: 'platform',
      grantedBy: 'sync-job',
      grantedAt: '2026-07-15T10:00:00Z',
      syncedAt: '2026-07-15T10:01:00Z',
      expiresAt: '2099-07-15T11:00:00Z',
    });

    expect(grant).toEqual({
      agent_id: 'lexware',
      principal: 'user_a@hybridai',
      role: 'user',
      source: 'platform',
      granted_by: 'sync-job',
      granted_at: '2026-07-15T10:00:00.000Z',
      synced_at: '2026-07-15T10:01:00.000Z',
      expires_at: '2099-07-15T11:00:00.000Z',
    });
    expect(grants.getAgentGrant('lexware', 'USER_A@HYBRIDAI')).toEqual(grant);
    expect(db.getAgentById('lexware')?.shared).toBe(true);

    const columns = db.withMemoryDatabase((database) =>
      database
        .prepare<[], { name: string }>('PRAGMA table_info(agent_grants)')
        .all()
        .map((row) => row.name),
    );
    expect(columns).toEqual(
      expect.arrayContaining([
        'agent_id',
        'principal',
        'role',
        'source',
        'granted_by',
        'granted_at',
        'synced_at',
        'expires_at',
      ]),
    );
  });

  test('fails closed for elapsed and malformed expiries', async () => {
    const { db, grants } = await setupGrantStore();
    grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: 'expired@hybridai.one',
      grantedBy: 'local-operator',
      expiresAt: '2026-07-15T09:59:59Z',
    });

    expect(
      grants.hasActiveAgentGrant('lexware', 'expired@hybridai', {
        now: new Date('2026-07-15T10:00:00Z'),
      }),
    ).toBe(false);
    expect(
      grants.listAgentGrantsForPrincipal('expired@hybridai', {
        now: new Date('2026-07-15T10:00:00Z'),
      }),
    ).toEqual([]);
    expect(db.getAgentById('lexware')?.shared).toBeUndefined();

    db.withMemoryDatabase((database) =>
      database
        .prepare(
          'UPDATE agent_grants SET expires_at = ? WHERE agent_id = ? AND principal = ?',
        )
        .run('not-a-date', 'lexware', 'expired@hybridai'),
    );
    expect(grants.hasActiveAgentGrant('lexware', 'expired@hybridai')).toBe(
      false,
    );
  });

  test('derives shared state from active grants without a grant-store read', async () => {
    const { db, grants } = await setupGrantStore();
    grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      grantedBy: 'local-operator',
      expiresAt: '2099-07-15T10:00:00Z',
    });
    expect(db.getAgentById('lexware')?.shared).toBe(true);

    db.withMemoryDatabase((database) =>
      database
        .prepare(
          'UPDATE agent_grants SET expires_at = ? WHERE agent_id = ? AND principal = ?',
        )
        .run('2000-01-01T00:00:00.000Z', 'lexware', 'user_a@hybridai'),
    );

    expect(db.getAgentById('lexware')?.shared).toBeUndefined();
  });

  test('aborts an active gateway request when its grant is revoked', async () => {
    const { grants } = await setupGrantStore();
    grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      grantedBy: 'local-operator',
    });
    const stopSessionExecution = vi.fn(() => true);
    vi.doMock('../src/agent/executor.js', () => ({ stopSessionExecution }));
    const { registerActiveGatewayRequest } = await import(
      '../src/gateway/gateway-request-runtime.js'
    );
    const request = registerActiveGatewayRequest({
      sessionId: 'shared-session',
      executionSessionId: 'shared-execution',
      agentId: 'lexware',
      principal: 'user_a@hybridai',
    });

    expect(
      grants.deleteAgentGrant('lexware', 'user_a@hybridai'),
    ).not.toBeNull();
    await Promise.resolve();

    expect(request.signal.aborted).toBe(true);
    expect((request.signal.reason as Error).message).toBe(
      'Agent access grant was revoked or expired.',
    );
    expect(stopSessionExecution).toHaveBeenCalledWith('shared-execution');
    request.release();
  });

  test('aborts an active gateway request when its grant naturally expires', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    try {
      const now = new Date('2026-07-15T10:00:00Z');
      vi.setSystemTime(now);
      const { db, grants } = await setupGrantStore();
      grants.upsertAgentGrant({
        agentId: 'lexware',
        principal: 'user_a@hybridai',
        grantedBy: 'local-operator',
        expiresAt: new Date(now.getTime() + 1_000),
      });
      const stopSessionExecution = vi.fn(() => true);
      vi.doMock('../src/agent/executor.js', () => ({ stopSessionExecution }));
      const { registerActiveGatewayRequest } = await import(
        '../src/gateway/gateway-request-runtime.js'
      );
      const request = registerActiveGatewayRequest({
        sessionId: 'shared-session',
        executionSessionId: 'shared-execution',
        agentId: 'lexware',
        principal: 'user_a@hybridai',
      });
      release = request.release;

      await vi.advanceTimersByTimeAsync(1_000);

      expect(request.signal.aborted).toBe(true);
      expect((request.signal.reason as Error).message).toBe(
        'Agent access grant was revoked or expired.',
      );
      expect(stopSessionExecution).toHaveBeenCalledWith('shared-execution');
      expect(db.getAgentById('lexware')?.shared).toBeUndefined();
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  test('polls active grants to catch revocation from another process', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    try {
      const { db, grants } = await setupGrantStore();
      grants.upsertAgentGrant({
        agentId: 'lexware',
        principal: 'user_a@hybridai',
        grantedBy: 'local-operator',
      });
      const stopSessionExecution = vi.fn(() => true);
      vi.doMock('../src/agent/executor.js', () => ({ stopSessionExecution }));
      const { registerActiveGatewayRequest } = await import(
        '../src/gateway/gateway-request-runtime.js'
      );
      const request = registerActiveGatewayRequest({
        sessionId: 'shared-session',
        executionSessionId: 'shared-execution',
        agentId: 'lexware',
        principal: 'user_a@hybridai',
      });
      release = request.release;

      db.withMemoryDatabase((database) =>
        database
          .prepare(
            'DELETE FROM agent_grants WHERE agent_id = ? AND principal = ?',
          )
          .run('lexware', 'user_a@hybridai'),
      );
      expect(request.signal.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);

      expect(request.signal.aborted).toBe(true);
      expect(stopSessionExecution).toHaveBeenCalledWith('shared-execution');
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  test('keeps shared state until the final active grant is removed', async () => {
    const { db, grants } = await setupGrantStore();
    const now = new Date('2026-07-15T10:00:00Z');
    for (const principal of ['user_a@hybridai', 'user_b@hybridai']) {
      grants.upsertAgentGrant({
        agentId: 'lexware',
        principal,
        grantedBy: 'local-operator',
        expiresAt: '2026-07-16T10:00:00Z',
      });
    }

    expect(
      grants.deleteAgentGrant('lexware', 'user_a@hybridai', { now }),
    ).toMatchObject({ principal: 'user_a@hybridai' });
    expect(db.getAgentById('lexware')?.shared).toBe(true);

    expect(
      grants.deleteAgentGrant('lexware', 'user_b@hybridai', { now }),
    ).toMatchObject({ principal: 'user_b@hybridai' });
    expect(db.getAgentById('lexware')?.shared).toBeUndefined();
  });

  test('cascades grants when an agent is deleted', async () => {
    const { db, grants } = await setupGrantStore();
    grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      grantedBy: 'local-operator',
    });

    expect(db.deleteAgent('lexware')).toBe(true);
    expect(
      grants.listAgentGrantsForPrincipal('user_a@hybridai', {
        includeExpired: true,
      }),
    ).toEqual([]);
  });

  test('records shared and unshared audit events for successful mutations', async () => {
    const { db, sharing } = await setupGrantStore();

    sharing.shareAgent({
      agentId: 'lexware',
      principal: 'User_A@HybridAI.One',
      grantedBy: 'admin@hybridai.one',
    });
    sharing.unshareAgent({
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      revokedBy: 'admin@hybridai',
    });

    const events = db.getRecentStructuredAuditForSession(
      sharing.agentGrantAuditSessionId('lexware'),
      10,
    );
    expect(events.map((event) => event.event_type)).toEqual([
      'agent.unshared',
      'agent.shared',
    ]);
    expect(events.every((event) => event.actor_id === 'admin@hybridai')).toBe(
      true,
    );
    expect(JSON.parse(events[0]?.payload || '{}')).toMatchObject({
      targetAgentId: 'lexware',
      principal: 'user_a@hybridai',
      revokedBy: 'admin@hybridai',
    });
  });

  test('rolls back share and unshare mutations when audit persistence fails', async () => {
    const { db, grants, sharing } = await setupGrantStore();
    const audit = await import('../src/audit/audit-trail.js');
    const auditSessionDir = audit.getAuditSessionDir(
      sharing.agentGrantAuditSessionId('lexware'),
    );
    fs.mkdirSync(path.dirname(auditSessionDir), { recursive: true });
    fs.writeFileSync(auditSessionDir, 'blocks audit session directory');

    expect(() =>
      sharing.shareAgent({
        agentId: 'lexware',
        principal: 'user_a@hybridai',
        grantedBy: 'admin@hybridai',
      }),
    ).toThrow();
    expect(grants.getAgentGrant('lexware', 'user_a@hybridai')).toBeNull();
    expect(db.getAgentById('lexware')?.shared).toBeUndefined();

    const storedGrant = grants.upsertAgentGrant({
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      grantedBy: 'admin@hybridai',
    });
    const stopSessionExecution = vi.fn(() => true);
    vi.doMock('../src/agent/executor.js', () => ({ stopSessionExecution }));
    const { registerActiveGatewayRequest } = await import(
      '../src/gateway/gateway-request-runtime.js'
    );
    const request = registerActiveGatewayRequest({
      sessionId: 'audit-rollback-session',
      agentId: 'lexware',
      principal: 'user_a@hybridai',
    });
    expect(() =>
      sharing.unshareAgent({
        agentId: 'lexware',
        principal: 'user_a@hybridai',
        revokedBy: 'admin@hybridai',
      }),
    ).toThrow();
    await Promise.resolve();
    expect(grants.getAgentGrant('lexware', 'user_a@hybridai')).toEqual(
      storedGrant,
    );
    expect(db.getAgentById('lexware')?.shared).toBe(true);
    expect(request.signal.aborted).toBe(false);
    expect(stopSessionExecution).not.toHaveBeenCalled();
    request.release();
  });

  test('rejects unsupported roles, sources, dates, and unknown agents', async () => {
    const { grants } = await setupGrantStore();
    const valid = {
      agentId: 'lexware',
      principal: 'user_a@hybridai',
      grantedBy: 'local-operator',
    };

    expect(() =>
      grants.upsertAgentGrant({ ...valid, role: 'admin' as never }),
    ).toThrow('Agent grant role must be `user`.');
    expect(() =>
      grants.upsertAgentGrant({ ...valid, source: 'remote' as never }),
    ).toThrow('Agent grant source must be `local` or `platform`.');
    expect(() =>
      grants.upsertAgentGrant({ ...valid, expiresAt: 'tomorrow-ish' }),
    ).toThrow('Agent grant `expiresAt` must be a valid date.');
    expect(() =>
      grants.upsertAgentGrant({ ...valid, agentId: 'missing' }),
    ).toThrow('Agent "missing" was not found.');
  });
});
