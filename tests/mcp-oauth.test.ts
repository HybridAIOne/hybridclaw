import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-mcp-oauth-'));
  tempDirs.push(dir);
  return dir;
}

async function importFreshMcpOAuth(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  return await import('../src/mcp/mcp-oauth.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (ORIGINAL_HYBRIDCLAW_DATA_DIR === undefined) {
    delete process.env.HYBRIDCLAW_DATA_DIR;
  } else {
    process.env.HYBRIDCLAW_DATA_DIR = ORIGINAL_HYBRIDCLAW_DATA_DIR;
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
}

function stubOAuthServerFetch(options?: {
  withProtectedResourceMetadata?: boolean;
  registrationFails?: boolean;
  tokenResponse?: Record<string, unknown>;
}): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  const tokenResponse = options?.tokenResponse ?? {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: 3600,
    scope: 'mcp.read',
  };

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
      requests.push({ url, method, body });

      if (url.includes('/.well-known/oauth-protected-resource')) {
        if (options?.withProtectedResourceMetadata === false) {
          return jsonResponse({ error: 'not found' }, 404);
        }
        if (url !== 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
          return jsonResponse({ error: 'not found' }, 404);
        }
        return jsonResponse({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
          scopes_supported: ['mcp.read', 'mcp.write'],
        });
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        if (!url.startsWith('https://auth.example.com/')) {
          return jsonResponse({ error: 'not found' }, 404);
        }
        return jsonResponse({
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        });
      }
      if (url.includes('/.well-known/openid-configuration')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (url === 'https://auth.example.com/register') {
        if (options?.registrationFails) {
          return jsonResponse({ error: 'access_denied' }, 403);
        }
        return jsonResponse({ client_id: 'client-123' }, 201);
      }
      if (url === 'https://auth.example.com/token') {
        return jsonResponse(tokenResponse);
      }
      return jsonResponse({ error: 'unexpected request' }, 500);
    }),
  );
  return requests;
}

test('start + complete flow discovers metadata, registers a client, and stores tokens', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  const requests = stubOAuthServerFetch();

  const started = await mod.startMcpOAuthFlow({
    serverName: 'linear',
    serverUrl: 'https://mcp.example.com/mcp',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
  });

  const authUrl = new URL(started.authorizationUrl);
  expect(authUrl.origin + authUrl.pathname).toBe(
    'https://auth.example.com/authorize',
  );
  expect(authUrl.searchParams.get('client_id')).toBe('client-123');
  expect(authUrl.searchParams.get('response_type')).toBe('code');
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('resource')).toBe(
    'https://mcp.example.com/mcp',
  );
  expect(authUrl.searchParams.get('scope')).toBe('mcp.read mcp.write');
  expect(authUrl.searchParams.get('state')).toBe(started.state);

  const completed = await mod.completeMcpOAuthFlow({
    state: started.state,
    code: 'auth-code-1',
  });
  expect(completed.serverName).toBe('linear');

  const tokenRequest = requests.find(
    (request) => request.url === 'https://auth.example.com/token',
  );
  expect(tokenRequest).toBeTruthy();
  const tokenBody = tokenRequest?.body as URLSearchParams;
  expect(tokenBody.get('grant_type')).toBe('authorization_code');
  expect(tokenBody.get('code')).toBe('auth-code-1');
  expect(tokenBody.get('resource')).toBe('https://mcp.example.com/mcp');
  const verifier = tokenBody.get('code_verifier') || '';
  const expectedChallenge = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  expect(authUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);

  const record = mod.getMcpOAuthRecord('linear');
  expect(record?.tokens?.accessToken).toBe('access-1');
  expect(record?.tokens?.refreshToken).toBe('refresh-1');

  const storePath = path.join(homeDir, 'mcp-oauth.json');
  expect(fs.existsSync(storePath)).toBe(true);
  expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
});

test('falls back to the server origin as issuer without protected resource metadata', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/oauth-protected-resource')) {
        return jsonResponse({ error: 'not found' }, 404);
      }
      if (
        url ===
        'https://mcp.example.com/.well-known/oauth-authorization-server'
      ) {
        return jsonResponse({
          authorization_endpoint: 'https://mcp.example.com/authorize',
          token_endpoint: 'https://mcp.example.com/token',
          registration_endpoint: 'https://mcp.example.com/register',
        });
      }
      if (url === 'https://mcp.example.com/register') {
        return jsonResponse({ client_id: 'client-xyz' }, 201);
      }
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );

  const started = await mod.startMcpOAuthFlow({
    serverName: 'local',
    serverUrl: 'https://mcp.example.com/mcp',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
  });
  expect(started.authorizationUrl.startsWith('https://mcp.example.com/authorize?')).toBe(true);
  expect(new URL(started.authorizationUrl).searchParams.get('resource')).toBe(
    'https://mcp.example.com/mcp',
  );
});

test('start fails with a clear error when registration is unsupported', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return jsonResponse({
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
        });
      }
      return jsonResponse({ error: 'not found' }, 404);
    }),
  );

  await expect(
    mod.startMcpOAuthFlow({
      serverName: 'noreg',
      serverUrl: 'https://mcp.example.com/mcp',
      redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
    }),
  ).rejects.toThrow(/dynamic client registration/);
});

test('complete rejects unknown state', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  await expect(
    mod.completeMcpOAuthFlow({ state: 'bogus', code: 'code' }),
  ).rejects.toThrow(/Unknown or expired/);
});

async function seedConnectedServer(
  mod: Awaited<ReturnType<typeof importFreshMcpOAuth>>,
  tokenOverrides?: Record<string, unknown>,
): Promise<void> {
  stubOAuthServerFetch({
    tokenResponse: {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      ...tokenOverrides,
    },
  });
  const started = await mod.startMcpOAuthFlow({
    serverName: 'linear',
    serverUrl: 'https://mcp.example.com/mcp',
    redirectUri: 'http://127.0.0.1:8787/api/mcp/oauth/callback',
  });
  await mod.completeMcpOAuthFlow({ state: started.state, code: 'code-1' });
}

test('ensureFreshMcpAccessToken returns the stored token while valid', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  await seedConnectedServer(mod);

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no network expected');
    }),
  );
  await expect(mod.ensureFreshMcpAccessToken('linear')).resolves.toBe(
    'access-1',
  );
});

test('ensureFreshMcpAccessToken refreshes expired tokens and persists the result', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  await seedConnectedServer(mod, { expires_in: 1 });

  const requests = stubOAuthServerFetch({
    tokenResponse: { access_token: 'access-2', expires_in: 3600 },
  });
  await expect(mod.ensureFreshMcpAccessToken('linear')).resolves.toBe(
    'access-2',
  );
  const refreshRequest = requests.find(
    (request) => request.url === 'https://auth.example.com/token',
  );
  const body = refreshRequest?.body as URLSearchParams;
  expect(body.get('grant_type')).toBe('refresh_token');
  expect(body.get('refresh_token')).toBe('refresh-1');

  // Rotated refresh tokens are kept; missing ones fall back to the old token.
  const record = mod.getMcpOAuthRecord('linear');
  expect(record?.tokens?.accessToken).toBe('access-2');
  expect(record?.tokens?.refreshToken).toBe('refresh-1');
});

test('ensureFreshMcpAccessToken returns null when refresh fails', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  await seedConnectedServer(mod, { expires_in: 1 });

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400)),
  );
  await expect(mod.ensureFreshMcpAccessToken('linear')).resolves.toBeNull();
});

test('resolveMcpServersForRuntime injects Authorization for oauth servers only', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);
  await seedConnectedServer(mod);

  const resolved = await mod.resolveMcpServersForRuntime({
    linear: {
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
      headers: { 'X-Extra': 'kept' },
    },
    plain: {
      transport: 'http',
      url: 'https://plain.example.com/mcp',
      headers: { Authorization: 'Bearer static' },
    },
    disabled: {
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      auth: 'oauth',
      enabled: false,
    },
    local: { transport: 'stdio', command: 'echo' },
  });

  expect(resolved.linear.headers).toEqual({
    'X-Extra': 'kept',
    Authorization: 'Bearer access-1',
  });
  expect(resolved.plain.headers).toEqual({ Authorization: 'Bearer static' });
  expect(resolved.disabled.headers).toBeUndefined();
  expect(resolved.local.headers).toBeUndefined();
});

test('getMcpOAuthStatus reports unauthorized, connected, and url changes', async () => {
  const homeDir = makeTempHome();
  const mod = await importFreshMcpOAuth(homeDir);

  expect(
    mod.getMcpOAuthStatus('linear', {
      auth: 'oauth',
      url: 'https://mcp.example.com/mcp',
    }),
  ).toEqual({ method: 'oauth', state: 'unauthorized' });
  expect(mod.getMcpOAuthStatus('linear', { url: 'x' })).toEqual({
    method: 'none',
  });

  await seedConnectedServer(mod);
  expect(
    mod.getMcpOAuthStatus('linear', {
      auth: 'oauth',
      url: 'https://mcp.example.com/mcp',
    }).state,
  ).toBe('connected');

  // Pointing the config at a different URL invalidates stored credentials.
  expect(
    mod.getMcpOAuthStatus('linear', {
      auth: 'oauth',
      url: 'https://other.example.com/mcp',
    }).state,
  ).toBe('unauthorized');

  mod.clearMcpOAuth('linear');
  expect(
    mod.getMcpOAuthStatus('linear', {
      auth: 'oauth',
      url: 'https://mcp.example.com/mcp',
    }).state,
  ).toBe('unauthorized');
});
