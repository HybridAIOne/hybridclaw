import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ISSUER = 'https://platform.example';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-hybridai-oauth-'),
  );
  tempDirs.push(dir);
  return dir;
}

async function importFresh(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  delete process.env.HYBRIDAI_API_KEY;
  const oauth = await import('../src/auth/hybridai-oauth.ts');
  const secrets = await import('../src/security/runtime-secrets.ts');
  return { oauth, secrets };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  if (ORIGINAL_HYBRIDCLAW_DATA_DIR === undefined) {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  } else {
    process.env.HYBRIDCLAW_DATA_DIR = ORIGINAL_HYBRIDCLAW_DATA_DIR;
  }
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedRequest {
  url: string;
  method: string;
  body: URLSearchParams | Record<string, unknown> | null;
  authorization: string | null;
}

/**
 * Fake platform: RFC 8414 metadata, open registration, a token endpoint that
 * hands out `hao_`/`hor_` tokens and rotates on refresh, plus userinfo.
 */
function stubPlatform(options?: {
  withMetadata?: boolean;
  withRegistration?: boolean;
  withDeviceFlow?: boolean;
  /** Token endpoint answers for device polls, in order; last one repeats. */
  devicePolls?: Array<'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'ok'>;
  deviceInterval?: number;
  refreshError?: { status: number; error: string };
  expiresIn?: number;
}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  let issued = 0;
  let polls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      let body: RecordedRequest['body'] = null;
      if (init?.body instanceof URLSearchParams) {
        body = init.body;
      } else if (typeof init?.body === 'string') {
        body = JSON.parse(init.body) as Record<string, unknown>;
      }
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method,
        body,
        authorization: headers.get('authorization'),
      });

      if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
        if (options?.withMetadata === false) return jsonResponse({}, 404);
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth/authorize`,
          token_endpoint: `${ISSUER}/oauth/token`,
          revocation_endpoint: `${ISSUER}/oauth/revoke`,
          ...(options?.withRegistration === false
            ? {}
            : { registration_endpoint: `${ISSUER}/oauth/register` }),
          ...(options?.withDeviceFlow
            ? {
                device_authorization_endpoint: `${ISSUER}/oauth/device_authorization`,
              }
            : {}),
          scopes_supported: ['profile', 'api', 'mcp'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return jsonResponse({}, 404);
      }
      if (url === `${ISSUER}/oauth/register`) {
        return jsonResponse({ client_id: 'hac_test' }, 201);
      }
      if (url === `${ISSUER}/oauth/device_authorization`) {
        return jsonResponse({
          device_code: 'dev-1',
          user_code: 'WXKT-QMBD',
          verification_uri: `${ISSUER}/device`,
          verification_uri_complete: `${ISSUER}/device?user_code=WXKT-QMBD`,
          expires_in: 900,
          interval: options?.deviceInterval ?? 0,
        });
      }
      if (url === `${ISSUER}/oauth/token`) {
        const params = body as URLSearchParams;
        if (
          params.get('grant_type') ===
          'urn:ietf:params:oauth:grant-type:device_code'
        ) {
          const script = options?.devicePolls ?? ['ok'];
          const answer = script[Math.min(polls, script.length - 1)];
          polls += 1;
          if (answer !== 'ok') return jsonResponse({ error: answer }, 400);
        }
        if (
          params.get('grant_type') === 'refresh_token' &&
          options?.refreshError
        ) {
          return jsonResponse(
            { error: options.refreshError.error },
            options.refreshError.status,
          );
        }
        issued += 1;
        return jsonResponse({
          access_token: `hao_access-${issued}`,
          refresh_token: `hor_refresh-${issued}`,
          token_type: 'Bearer',
          expires_in: options?.expiresIn ?? 3600,
          scope: 'profile api mcp',
        });
      }
      if (url === `${ISSUER}/oauth/userinfo`) {
        return jsonResponse({
          sub: 'user-1',
          email: 'max@example.com',
          name: 'Max',
        });
      }
      if (url === `${ISSUER}/oauth/revoke`) {
        return new Response(null, { status: 200 });
      }
      return jsonResponse({ error: `unexpected ${url}` }, 500);
    }),
  );
  return requests;
}

test('sign-in registers a loopback client, exchanges the code with PKCE and stores both secrets', async () => {
  const homeDir = makeTempHome();
  const requests = stubPlatform();
  const { oauth, secrets } = await importFresh(homeDir);

  const authorization = await oauth.startHybridAIAuthorization({
    baseUrl: `${ISSUER}/`,
  });
  const authorizeUrl = new URL(authorization.authorizationUrl);
  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
    `${ISSUER}/oauth/authorize`,
  );
  expect(authorizeUrl.searchParams.get('client_id')).toBe('hac_test');
  expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorizeUrl.searchParams.get('scope')).toBe('profile api mcp');
  expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(
    authorization.redirectUri,
  );
  expect(authorization.redirectUri).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
  );
  const registration = requests.find((r) => r.url === `${ISSUER}/oauth/register`);
  expect(registration?.body).toMatchObject({
    client_name: 'HybridClaw',
    redirect_uris: [authorization.redirectUri],
    token_endpoint_auth_method: 'none',
  });

  // The browser lands on the loopback listener with the real state.
  const callbackUrl = new URL(authorization.redirectUri);
  callbackUrl.searchParams.set('code', 'code-1');
  callbackUrl.searchParams.set(
    'state',
    authorizeUrl.searchParams.get('state') || '',
  );
  // The fetch stub only knows the platform; hit the listener with node's http.
  const http = await import('node:http');
  await new Promise<void>((resolve, reject) => {
    http
      .get(callbackUrl, (res) => {
        expect(res.statusCode).toBe(200);
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
  const code = await authorization.waitForCode;
  expect(code).toBe('code-1');

  const signIn = await authorization.complete(code);
  expect(signIn.accessToken).toBe('hao_access-1');
  expect(signIn.account).toEqual({
    sub: 'user-1',
    email: 'max@example.com',
    name: 'Max',
  });

  const tokenRequest = requests.find(
    (r) => r.url === `${ISSUER}/oauth/token`,
  );
  const params = tokenRequest?.body as URLSearchParams;
  expect(params.get('grant_type')).toBe('authorization_code');
  expect(params.get('client_id')).toBe('hac_test');
  expect(params.get('redirect_uri')).toBe(authorization.redirectUri);
  expect(params.get('code_verifier')).toBeTruthy();
  expect(params.has('client_secret')).toBe(false);

  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hao_access-1',
  );
  const record = oauth.readHybridAIOAuthRecord();
  expect(record).toMatchObject({
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/oauth/token`,
    revocationEndpoint: `${ISSUER}/oauth/revoke`,
    clientId: 'hac_test',
    refreshToken: 'hor_refresh-1',
    account: { email: 'max@example.com' },
  });
  expect(record?.accessExpiresAt).toBeGreaterThan(Date.now());
  const stored = fs.readFileSync(secrets.runtimeSecretsPath(), 'utf-8');
  expect(stored).not.toContain('hao_access-1');
  expect(stored).not.toContain('hor_refresh-1');
});

test('a pasted redirect URL completes the flow and a wrong state is rejected', async () => {
  const homeDir = makeTempHome();
  stubPlatform();
  const { oauth } = await importFresh(homeDir);

  const first = await oauth.startHybridAIAuthorization({ baseUrl: ISSUER });
  first.submitRedirect(
    `${first.redirectUri}?code=pasted-code&state=not-the-state`,
  );
  await expect(first.waitForCode).rejects.toThrow(/state mismatch/);

  const second = await oauth.startHybridAIAuthorization({ baseUrl: ISSUER });
  const state = new URL(second.authorizationUrl).searchParams.get('state');
  second.submitRedirect(`${second.redirectUri}?code=pasted-code&state=${state}`);
  await expect(second.waitForCode).resolves.toBe('pasted-code');

  const third = await oauth.startHybridAIAuthorization({ baseUrl: ISSUER });
  third.submitRedirect('  bare-code-42  ');
  await expect(third.waitForCode).resolves.toBe('bare-code-42');
});

test('sign-in fails fast when the platform publishes no OAuth metadata or registration', async () => {
  const homeDir = makeTempHome();
  stubPlatform({ withMetadata: false });
  const { oauth } = await importFresh(homeDir);
  await expect(
    oauth.startHybridAIAuthorization({ baseUrl: ISSUER }),
  ).rejects.toThrow(/does not publish OAuth authorization server metadata/);

  stubPlatform({ withRegistration: false });
  await expect(
    oauth.startHybridAIAuthorization({ baseUrl: ISSUER }),
  ).rejects.toThrow(/dynamic client registration/);
});

async function signIn(oauth: Awaited<ReturnType<typeof importFresh>>['oauth']) {
  const authorization = await oauth.startHybridAIAuthorization({
    baseUrl: ISSUER,
  });
  authorization.submitRedirect('code-1');
  await authorization.complete(await authorization.waitForCode);
}

test('ensureFreshHybridAIAccessToken leaves a fresh token alone and rotates one that is about to expire', async () => {
  const homeDir = makeTempHome();
  const requests = stubPlatform({ expiresIn: 3600 });
  const { oauth, secrets } = await importFresh(homeDir);
  await signIn(oauth);

  await expect(oauth.ensureFreshHybridAIAccessToken()).resolves.toBe('fresh');
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hao_access-1',
  );

  // Under the 15 minute threshold: refresh with rotation.
  await expect(
    oauth.ensureFreshHybridAIAccessToken({ minTtlMs: 2 * 3600 * 1000 }),
  ).resolves.toBe('refreshed');
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hao_access-2',
  );
  expect(oauth.readHybridAIOAuthRecord()?.refreshToken).toBe('hor_refresh-2');
  const refresh = requests
    .filter((r) => r.url === `${ISSUER}/oauth/token`)
    .at(-1);
  const params = refresh?.body as URLSearchParams;
  expect(params.get('grant_type')).toBe('refresh_token');
  expect(params.get('refresh_token')).toBe('hor_refresh-1');
  expect(params.get('client_id')).toBe('hac_test');
});

test('ensureFreshHybridAIAccessToken signs out on invalid_grant and keeps everything on transient errors', async () => {
  const homeDir = makeTempHome();
  stubPlatform({ refreshError: { status: 503, error: 'temporarily_unavailable' } });
  const { oauth, secrets } = await importFresh(homeDir);
  await signIn(oauth);

  await expect(
    oauth.ensureFreshHybridAIAccessToken({ minTtlMs: 2 * 3600 * 1000 }),
  ).resolves.toBe('unavailable');
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hao_access-1',
  );
  expect(oauth.readHybridAIOAuthRecord()?.refreshToken).toBe('hor_refresh-1');

  stubPlatform({ refreshError: { status: 400, error: 'invalid_grant' } });
  await expect(
    oauth.ensureFreshHybridAIAccessToken({ minTtlMs: 2 * 3600 * 1000 }),
  ).resolves.toBe('signed-out');
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBeNull();
  expect(oauth.readHybridAIOAuthRecord()?.refreshToken).toBeUndefined();
});

test('ensureFreshHybridAIAccessToken is a no-op without a session and drops a session replaced by a platform key', async () => {
  const homeDir = makeTempHome();
  stubPlatform();
  const { oauth, secrets } = await importFresh(homeDir);
  await expect(oauth.ensureFreshHybridAIAccessToken()).resolves.toBe(
    'not-oauth',
  );

  await signIn(oauth);
  secrets.saveRuntimeSecrets({ HYBRIDAI_API_KEY: 'hai-pasted1234567890' });
  await expect(oauth.ensureFreshHybridAIAccessToken()).resolves.toBe(
    'not-oauth',
  );
  expect(oauth.readHybridAIOAuthRecord()).toBeNull();
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hai-pasted1234567890',
  );
});

test('revokeHybridAIOAuthSession revokes the refresh token and forgets the session', async () => {
  const homeDir = makeTempHome();
  const requests = stubPlatform();
  const { oauth } = await importFresh(homeDir);
  await signIn(oauth);

  await expect(oauth.revokeHybridAIOAuthSession()).resolves.toBe(true);
  const revoke = requests.find((r) => r.url === `${ISSUER}/oauth/revoke`);
  const params = revoke?.body as URLSearchParams;
  expect(params.get('token')).toBe('hor_refresh-1');
  expect(params.get('token_type_hint')).toBe('refresh_token');
  expect(params.get('client_id')).toBe('hac_test');
  expect(oauth.readHybridAIOAuthRecord()).toBeNull();
  await expect(oauth.revokeHybridAIOAuthSession()).resolves.toBe(false);
});

test('device flow registers a device-capable client, polls through pending and slow_down, and stores the session', async () => {
  const homeDir = makeTempHome();
  const requests = stubPlatform({
    withDeviceFlow: true,
    devicePolls: ['authorization_pending', 'slow_down', 'ok'],
  });
  const { oauth, secrets } = await importFresh(homeDir);

  const device = await oauth.startHybridAIDeviceAuthorization({
    baseUrl: ISSUER,
  });
  expect(device).not.toBeNull();
  if (!device) throw new Error('unreachable');
  expect(device.userCode).toBe('WXKT-QMBD');
  expect(device.verificationUri).toBe(`${ISSUER}/device`);
  expect(device.verificationUriComplete).toBe(
    `${ISSUER}/device?user_code=WXKT-QMBD`,
  );
  expect(device.expiresAt).toBeGreaterThan(Date.now());
  const registration = requests.find(
    (r) => r.url === `${ISSUER}/oauth/register`,
  );
  expect(registration?.body).toMatchObject({
    grant_types: ['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    token_endpoint_auth_method: 'none',
  });
  const deviceRequest = requests.find(
    (r) => r.url === `${ISSUER}/oauth/device_authorization`,
  );
  const deviceParams = deviceRequest?.body as URLSearchParams;
  expect(deviceParams.get('client_id')).toBe('hac_test');
  expect(deviceParams.get('scope')).toBe('profile api mcp');

  vi.useFakeTimers();
  const pending = device.waitForSignIn();
  // interval 0 → poll 1 (pending) → poll 2 (slow_down, +5 s) → poll 3 (ok)
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersByTimeAsync(5_000);
  const signIn = await pending;
  vi.useRealTimers();

  expect(signIn.accessToken).toBe('hao_access-1');
  expect(signIn.account?.email).toBe('max@example.com');
  const polls = requests.filter(
    (r) =>
      r.url === `${ISSUER}/oauth/token` &&
      (r.body as URLSearchParams).get('grant_type') ===
        'urn:ietf:params:oauth:grant-type:device_code',
  );
  expect(polls).toHaveLength(3);
  expect((polls[0]?.body as URLSearchParams).get('device_code')).toBe('dev-1');
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
    'hao_access-1',
  );
  expect(oauth.readHybridAIOAuthRecord()).toMatchObject({
    clientId: 'hac_test',
    refreshToken: 'hor_refresh-1',
    tokenEndpoint: `${ISSUER}/oauth/token`,
  });
  await expect(device.waitForSignIn()).rejects.toThrow(/already started/);
});

test('device flow reports denial and expiry, and is skipped on platforms without it', async () => {
  const homeDir = makeTempHome();
  stubPlatform({ withDeviceFlow: true, devicePolls: ['access_denied'] });
  const { oauth, secrets } = await importFresh(homeDir);
  const denied = await oauth.startHybridAIDeviceAuthorization({
    baseUrl: ISSUER,
  });
  await expect(denied?.waitForSignIn()).rejects.toThrow(/denied/);

  stubPlatform({ withDeviceFlow: true, devicePolls: ['expired_token'] });
  const expired = await oauth.startHybridAIDeviceAuthorization({
    baseUrl: ISSUER,
  });
  await expect(expired?.waitForSignIn()).rejects.toThrow(/expired/);
  expect(secrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBeNull();

  stubPlatform({ withDeviceFlow: true, deviceInterval: 5 });
  const canceled = await oauth.startHybridAIDeviceAuthorization({
    baseUrl: ISSUER,
  });
  const waiting = canceled?.waitForSignIn();
  canceled?.cancel();
  await expect(waiting).rejects.toThrow(/canceled/);

  stubPlatform();
  await expect(
    oauth.startHybridAIDeviceAuthorization({ baseUrl: ISSUER }),
  ).resolves.toBeNull();
});
