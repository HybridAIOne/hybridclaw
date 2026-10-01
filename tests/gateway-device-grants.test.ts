import { createHmac } from 'node:crypto';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir('hybridclaw-device-grants-');
const ORIGIN = 'http://127.0.0.1:9090';
const AUDIT = { sessionId: 'admin-session-1', actor: 'admin-user' };
const T0 = 1_790_000_000_000;

async function importDeviceGrants() {
  vi.resetModules();
  const recordAuditEvent = vi.fn();
  vi.doMock('../src/audit/audit-events.js', () => ({
    makeAuditRunId: (prefix: string) => `${prefix}-run`,
    recordAuditEvent,
  }));
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true, dbPath: path.join(makeTempDir(), 'db.sqlite') });
  const grants = await import('../src/gateway/device-grants.ts');
  const registry = await import('../src/security/api-tokens.ts');
  const rbac = await import('../src/security/admin-rbac.ts');
  const start = (now = T0) =>
    grants.startDeviceGrant({
      clientName: 'HybridClaw for iPhone',
      sourceIp: '192.168.1.20',
      origin: ORIGIN,
      now,
    });
  return { grants, recordAuditEvent, registry, rbac, start };
}

function signPass(
  payload: Record<string, unknown>,
  secret = 'handoff-secret',
): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(segment)
    .digest('base64url');
  return `${segment}.${signature}`;
}

function pass(overrides: Record<string, unknown> = {}): string {
  return signPass({
    sub: 'owner-1',
    jti: 'pass-1',
    typ: 'device-handoff',
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  });
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    writeHead(status: number) {
      res.statusCode = status;
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res;
}

describe('device authorization grants', () => {
  useCleanMocks({
    resetModules: true,
    unmock: ['../src/audit/audit-events.js'],
  });

  test('an approved device collects one scoped token, once', async () => {
    const { grants, recordAuditEvent, registry, start } =
      await importDeviceGrants();
    const started = start();
    expect(started.user_code).toMatch(/^[b-z2-9]{4}-[b-z2-9]{4}$/);
    expect(started.verification_uri).toBe(
      `${ORIGIN}/admin/credentials?tab=devices`,
    );
    expect(started.verification_uri_complete).toBe(
      `${started.verification_uri}&code=${started.user_code}`,
    );
    expect(started).toMatchObject({ expires_in: 600, interval: 5 });

    expect(grants.pollDeviceGrant(started.device_code, T0).body).toEqual({
      error: 'authorization_pending',
    });
    expect(grants.pollDeviceGrant(started.device_code, T0 + 1000).body).toEqual(
      { error: 'slow_down' },
    );

    // What the approver reads: typed loosely, it still finds the device.
    const typed = started.user_code.toUpperCase().replace('-', ' ');
    expect(grants.describeDeviceGrant(typed, T0 + 2000)).toMatchObject({
      clientName: 'HybridClaw for iPhone',
      sourceIp: '192.168.1.20',
    });
    grants.decideDeviceGrant({
      userCode: typed,
      approve: true,
      audit: AUDIT,
      now: T0 + 3000,
    });
    expect(() =>
      grants.decideDeviceGrant({
        userCode: started.user_code,
        approve: false,
        audit: AUDIT,
        now: T0 + 3500,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 409 }));

    const collected = grants.pollDeviceGrant(started.device_code, T0 + 9000);
    expect(collected.status).toBe(200);
    const token = collected.body.access_token;
    expect(registry.verifyApiToken(token)).toMatchObject({
      label: 'Device: HybridClaw for iPhone',
      claims: {
        actions: ['chat.send', 'agents.read', 'artifacts.read', 'voice.session'],
      },
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      sessionId: 'admin-session-1',
      event: { type: 'token.created', actor: 'admin-user' },
    });
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(token);
    expect(grants.pollDeviceGrant(started.device_code, T0 + 15000)).toEqual({
      status: 400,
      body: { error: 'expired_token' },
    });
  });

  test('a denied or expired device gets nothing', async () => {
    const { grants, registry, start } = await importDeviceGrants();
    const denied = start();
    grants.decideDeviceGrant({
      userCode: denied.user_code,
      approve: false,
      audit: AUDIT,
      now: T0,
    });
    expect(grants.pollDeviceGrant(denied.device_code, T0 + 6000).body).toEqual({
      error: 'access_denied',
    });
    expect(grants.pollDeviceGrant(denied.device_code, T0 + 12000).body).toEqual(
      { error: 'expired_token' },
    );

    const late = start();
    expect(() =>
      grants.decideDeviceGrant({
        userCode: late.user_code,
        approve: true,
        audit: AUDIT,
        now: T0 + 600_000,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 404 }));
    expect(grants.pollDeviceGrant(late.device_code, T0 + 600_000).body).toEqual({
      error: 'expired_token',
    });
    expect(grants.pollDeviceGrant('not-a-device-code').body).toEqual({
      error: 'expired_token',
    });
    expect(registry.listApiTokens()).toEqual([]);
  });

  test('unauthenticated starts are validated and capped', async () => {
    const { grants, start } = await importDeviceGrants();
    for (const clientName of [undefined, '', 'x'.repeat(81), 42]) {
      expect(() =>
        grants.startDeviceGrant({ clientName, sourceIp: null, origin: ORIGIN }),
      ).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    for (let i = 0; i < 20; i += 1) start();
    expect(() => start()).toThrow(expect.objectContaining({ statusCode: 429 }));
    // Expired requests free their places.
    expect(() => start(T0 + 600_000)).not.toThrow();
  });

  test('only an admin session that may create tokens can answer a device', async () => {
    const { grants, start } = await importDeviceGrants();
    const started = start(Date.now());
    const request = { method: 'GET' } as never;
    const path = `${started.user_code}`;
    for (const context of [
      { kind: 'apiToken', payload: { actions: ['*'] } },
      { kind: 'session', payload: { actions: ['admin.tokens.read'] } },
    ]) {
      const res = fakeResponse();
      await grants.handleAdminDeviceRoute(request, res as never, path, context, AUDIT);
      expect(res.statusCode).toBe(403);
    }
    const res = fakeResponse();
    await grants.handleAdminDeviceRoute(
      request,
      res as never,
      path,
      { kind: 'localSession', payload: null },
      AUDIT,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).device.clientName).toBe('HybridClaw for iPhone');
    expect(JSON.parse(res.body).device).not.toHaveProperty('deviceCode');
  });

  test('device routes and documents have their own actions', async () => {
    const { rbac } = await importDeviceGrants();
    expect(rbac.resolveAdminRbacAction('/api/artifact', 'GET')).toBe(
      'artifacts.read',
    );
    expect(rbac.resolveAdminRbacAction('/api/admin/devices/bcdf-ghjk', 'GET')).toBe(
      'admin.tokens.create',
    );
    expect(
      rbac.resolveAdminRbacAction('/api/admin/devices/bcdf-ghjk', 'POST'),
    ).toBe('admin.tokens.create');
    expect(
      rbac.isAdminActionAllowed({ actions: ['chat.send'] }, 'artifacts.read'),
    ).toBe(false);
  });

  test("a signed pass becomes one owner's token, once", async () => {
    vi.stubEnv('HYBRIDCLAW_AUTH_SECRET', 'handoff-secret');
    const { grants, recordAuditEvent, registry, rbac } =
      await importDeviceGrants();
    const redeem = (handoff: unknown) =>
      grants.redeemDeviceHandoff({
        handoff,
        clientName: 'Hy for iPhone',
        sourceIp: '203.0.113.7',
      });

    const first = redeem(pass());
    expect(first.status).toBe(200);
    const token = first.body.access_token;
    const verified = registry.verifyApiToken(token);
    expect(verified).toMatchObject({
      label: 'Device: Hy for iPhone',
      claims: {
        actions: [
          'chat.send',
          'agents.read',
          'artifacts.read',
          'voice.session',
          'chat.history',
        ],
        owner: true,
      },
    });
    expect(grants.isOwnerDeviceToken(verified?.claims)).toBe(true);
    expect(
      rbac.isAdminActionAllowed(verified?.claims ?? null, 'chat.history'),
    ).toBe(true);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      sessionId: 'device-handoff:pass-1',
      event: { type: 'token.created', actor: 'owner-1', sourceIp: '203.0.113.7' },
    });
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(token);

    // Spent, launch-typed, foreign or expired passes mint nothing.
    for (const handoff of [
      pass(),
      pass({ jti: 'pass-2', typ: 'launch' }),
      signPass({ sub: 'owner-1', jti: 'pass-3', typ: 'device-handoff', exp: Math.floor(Date.now() / 1000) + 60 }, 'other-secret'),
      pass({ jti: 'pass-4', exp: Math.floor(Date.now() / 1000) - 1 }),
      42,
    ]) {
      expect(redeem(handoff)).toEqual({
        status: 400,
        body: { error: 'invalid_grant' },
      });
    }
    expect(() =>
      grants.redeemDeviceHandoff({
        handoff: pass({ jti: 'pass-5' }),
        clientName: '',
        sourceIp: null,
      }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(registry.listApiTokens()).toHaveLength(1);
  });

  test('a code-paired device is not the owner', async () => {
    const { grants, registry, start } = await importDeviceGrants();
    const started = start(Date.now());
    grants.decideDeviceGrant({
      userCode: started.user_code,
      approve: true,
      audit: AUDIT,
    });
    const token = grants.pollDeviceGrant(started.device_code).body.access_token;
    expect(
      grants.isOwnerDeviceToken(registry.verifyApiToken(token)?.claims),
    ).toBe(false);
  });

  test('a device signs out by revoking its own token', async () => {
    vi.stubEnv('HYBRIDCLAW_AUTH_SECRET', 'handoff-secret');
    const { grants, registry } = await importDeviceGrants();
    const mint = (jti: string) =>
      grants.redeemDeviceHandoff({
        handoff: pass({ jti }),
        clientName: 'Hy for iPhone',
        sourceIp: null,
      }).body.access_token;
    const mine = mint('pass-a');
    const other = mint('pass-b');
    const signOut = async (authorization?: string) => {
      const res = fakeResponse();
      await grants.handleDeviceGrantRoute(
        {
          method: 'DELETE',
          headers: authorization ? { authorization } : {},
          socket: { remoteAddress: '203.0.113.7' },
        } as never,
        res as never,
        '/api/device/token',
        ORIGIN,
      );
      return res;
    };
    expect((await signOut()).statusCode).toBe(401);
    expect((await signOut('Bearer hck_not-a-token')).statusCode).toBe(401);
    expect((await signOut(`Bearer ${mine}`)).statusCode).toBe(200);
    expect(registry.verifyApiToken(mine)).toBeNull();
    expect(registry.verifyApiToken(other)).not.toBeNull();
    expect((await signOut(`Bearer ${mine}`)).statusCode).toBe(401);
  });
});
