import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-hubspot-auth-'),
  );
  tempDirs.push(dir);
  return dir;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshHubSpotAuth(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  return await import('../src/auth/hubspot-auth.ts');
}

async function importFreshAuthCommand(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  return await import('../src/cli/auth-command.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_HYBRIDCLAW_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HUBSPOT_ACCESS_TOKEN', ORIGINAL_HUBSPOT_ACCESS_TOKEN);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HubSpot auth stores OAuth refresh token and reports status', async () => {
  const homeDir = makeTempHome();
  const { getHubSpotAuthStatus, loginHubSpot } =
    await importFreshHubSpotAuth(homeDir);

  const result = await loginHubSpot({
    account: 'sales@example.com',
    clientId: 'hubspot-client-id',
    clientSecret: 'hubspot-client-secret',
    refreshToken: 'hubspot-refresh-token',
    scopes: ['crm.objects.contacts.read', 'oauth'],
  });

  expect(result).toMatchObject({
    account: 'sales@example.com',
    scopes: ['crm.objects.contacts.read', 'oauth'],
  });
  expect(result.secretsPath).toContain('credentials.json');
  expect(
    fs.readFileSync(path.join(homeDir, 'hubspot-auth.json'), 'utf-8'),
  ).toContain('crm.objects.contacts.read');

  expect(getHubSpotAuthStatus()).toMatchObject({
    authenticated: true,
    account: 'sales@example.com',
    scopes: ['crm.objects.contacts.read', 'oauth'],
  });
  const { readStoredRuntimeSecret } = await import(
    '../src/security/runtime-secrets.ts'
  );
  expect(readStoredRuntimeSecret('HUBSPOT_SCOPES')).toBeNull();
});

test('HubSpot runtime env mints short-lived access token from stored refresh token', async () => {
  const homeDir = makeTempHome();
  delete process.env.HUBSPOT_ACCESS_TOKEN;
  const { loginHubSpot, resolveHubSpotRuntimeEnv } =
    await importFreshHubSpotAuth(homeDir);

  await loginHubSpot({
    clientId: 'hubspot-client-id',
    clientSecret: 'hubspot-client-secret',
    refreshToken: 'hubspot-refresh-token',
    scopes: ['crm.objects.deals.read', 'oauth'],
  });
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'minted-hubspot-access-token',
        expires_in: 1800,
        token_type: 'bearer',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(resolveHubSpotRuntimeEnv()).resolves.toEqual({
    HUBSPOT_ACCESS_TOKEN: 'minted-hubspot-access-token',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://api.hubapi.com/oauth/2026-03/token',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
    'grant_type=refresh_token',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
    'client_id=hubspot-client-id',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
    'client_secret=hubspot-client-secret',
  );
});

test('HubSpot runtime env uses stored private app access token', async () => {
  const homeDir = makeTempHome();
  process.env.HUBSPOT_ACCESS_TOKEN = 'old-env-access-token';
  const {
    getHubSpotAuthStatus,
    resolveHubSpotAccessToken,
    resolveHubSpotRuntimeEnv,
  } = await importFreshHubSpotAuth(homeDir);
  const { saveNamedRuntimeSecrets } = await import(
    '../src/security/runtime-secrets.ts'
  );
  saveNamedRuntimeSecrets({
    HUBSPOT_ACCESS_TOKEN: 'private-app-access-token',
  });

  expect(getHubSpotAuthStatus()).toMatchObject({
    authenticated: true,
    authMode: 'private-app-token',
    accessTokenSource: 'runtime-secrets',
  });
  await expect(resolveHubSpotAccessToken()).resolves.toEqual({
    accessToken: 'private-app-access-token',
    source: 'store',
  });
  await expect(resolveHubSpotRuntimeEnv()).resolves.toEqual({
    HUBSPOT_ACCESS_TOKEN: 'private-app-access-token',
  });
});

test('auth command handles HubSpot private app access token login', async () => {
  const homeDir = makeTempHome();
  const { handleAuthCommand } = await importFreshAuthCommand(homeDir);
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    logs.push(String(line));
  });

  await handleAuthCommand([
    'login',
    'hubspot',
    '--access-token',
    'private-app-access-token',
    '--account',
    'sales@example.com',
  ]);
  await handleAuthCommand(['status', 'hubspot']);
  await handleAuthCommand(['logout', 'hubspot']);

  logSpy.mockRestore();
  expect(logs.join('\n')).toContain('Saved HubSpot private app access token');
  expect(logs.join('\n')).toContain('Account: sales@example.com');
  expect(logs.join('\n')).toContain('Private app access token: configured');
  expect(logs.join('\n')).toContain('Cleared HubSpot credentials');
});

test('HubSpot authorize URL includes scopes, redirect URI, and state', async () => {
  const homeDir = makeTempHome();
  const { buildHubSpotAuthorizeUrl } = await importFreshHubSpotAuth(homeDir);
  const url = new URL(
    buildHubSpotAuthorizeUrl({
      clientId: 'hubspot-client-id',
      redirectUri: 'http://127.0.0.1:1455/oauth2/callback',
      state: 'state-value',
      scopes: ['crm.objects.contacts.read', 'oauth'],
    }),
  );

  expect(url.origin + url.pathname).toBe(
    'https://app.hubspot.com/oauth/authorize',
  );
  expect(url.searchParams.get('client_id')).toBe('hubspot-client-id');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:1455/oauth2/callback',
  );
  expect(url.searchParams.get('scope')).toBe('crm.objects.contacts.read oauth');
  expect(url.searchParams.get('state')).toBe('state-value');
});

test('auth command handles HubSpot login, status, and logout', async () => {
  const homeDir = makeTempHome();
  const { handleAuthCommand } = await importFreshAuthCommand(homeDir);
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    logs.push(String(line));
  });

  await handleAuthCommand([
    'login',
    'hubspot',
    '--client-id',
    'hubspot-client-id',
    '--client-secret',
    'hubspot-client-secret',
    '--refresh-token',
    'hubspot-refresh-token',
    '--account',
    'sales@example.com',
  ]);
  await handleAuthCommand(['status', 'hubspot']);
  await handleAuthCommand(['logout', 'hubspot']);

  logSpy.mockRestore();
  expect(logs.join('\n')).toContain('Saved HubSpot OAuth credentials');
  expect(logs.join('\n')).toContain('Account: sales@example.com');
  expect(logs.join('\n')).toContain('Authenticated: yes');
  expect(logs.join('\n')).toContain('Cleared HubSpot credentials');
});

test('help topic prints HubSpot auth usage', async () => {
  const homeDir = makeTempHome();
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  const { printHelpTopic } = await import('../src/cli/help.ts');
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    logs.push(String(line));
  });

  await expect(printHelpTopic('hubspot')).resolves.toBe(true);

  logSpy.mockRestore();
  expect(logs.join('\n')).toContain('hybridclaw auth login hubspot');
});
