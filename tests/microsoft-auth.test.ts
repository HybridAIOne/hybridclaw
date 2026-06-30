import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-microsoft-auth-'),
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

async function importFreshMicrosoftAuth(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  return await import('../src/auth/microsoft-auth.ts');
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Microsoft 365 auth stores OAuth refresh token and reports status', async () => {
  const homeDir = makeTempHome();
  const { getMicrosoft365AuthStatus, loginMicrosoft365 } =
    await importFreshMicrosoftAuth(homeDir);

  const result = await loginMicrosoft365({
    account: 'user@example.com',
    tenantId: 'contoso.onmicrosoft.com',
    clientId: 'microsoft-client-id',
    clientSecret: 'microsoft-client-secret',
    refreshToken: 'microsoft-refresh-token',
    scopes: ['offline_access', 'User.Read', 'Mail.Read'],
  });

  expect(result).toMatchObject({
    account: 'user@example.com',
    tenantId: 'contoso.onmicrosoft.com',
    scopes: ['offline_access', 'User.Read', 'Mail.Read'],
    usedProvidedRefreshToken: true,
  });
  expect(result.secretsPath).toContain('credentials.json');

  expect(getMicrosoft365AuthStatus()).toMatchObject({
    authenticated: true,
    account: 'user@example.com',
    tenantId: 'contoso.onmicrosoft.com',
    scopes: ['offline_access', 'User.Read', 'Mail.Read'],
    clientSecretConfigured: true,
  });
});

test('Microsoft 365 runtime token minting uses tenant token endpoint', async () => {
  const homeDir = makeTempHome();
  const { loginMicrosoft365, resolveMicrosoft365AccessToken } =
    await importFreshMicrosoftAuth(homeDir);

  await loginMicrosoft365({
    tenantId: 'organizations',
    clientId: 'microsoft-client-id',
    refreshToken: 'microsoft-refresh-token',
    scopes: ['offline_access', 'User.Read'],
  });
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'minted-microsoft-access-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(resolveMicrosoft365AccessToken()).resolves.toEqual({
    accessToken: 'minted-microsoft-access-token',
    source: 'microsoft-oauth',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
    'grant_type=refresh_token',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
    'client_id=microsoft-client-id',
  );
  expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain(
    'client_secret=',
  );
});

test('Microsoft 365 authorize URL includes tenant, scopes, and PKCE challenge', async () => {
  const homeDir = makeTempHome();
  const { buildMicrosoft365AuthorizeUrl } =
    await importFreshMicrosoftAuth(homeDir);
  const url = new URL(
    buildMicrosoft365AuthorizeUrl({
      tenantId: 'contoso.onmicrosoft.com',
      clientId: 'microsoft-client-id',
      redirectUri: 'http://127.0.0.1:1455/oauth2/callback',
      state: 'state-value',
      scopes: ['offline_access', 'User.Read'],
      codeChallenge: 'code-challenge',
    }),
  );

  expect(url.origin + url.pathname).toBe(
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
  );
  expect(url.searchParams.get('client_id')).toBe('microsoft-client-id');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:1455/oauth2/callback',
  );
  expect(url.searchParams.get('scope')).toBe('offline_access User.Read');
  expect(url.searchParams.get('state')).toBe('state-value');
  expect(url.searchParams.get('code_challenge')).toBe('code-challenge');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
});

test('auth command handles Microsoft 365 login, status, and logout', async () => {
  const homeDir = makeTempHome();
  const { handleAuthCommand } = await importFreshAuthCommand(homeDir);
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    logs.push(String(line));
  });

  await handleAuthCommand([
    'login',
    'm365',
    '--client-id',
    'microsoft-client-id',
    '--tenant-id',
    'organizations',
    '--refresh-token',
    'microsoft-refresh-token',
    '--account',
    'user@example.com',
  ]);
  await handleAuthCommand(['status', 'microsoft365']);
  await handleAuthCommand(['logout', 'microsoft365']);

  logSpy.mockRestore();
  expect(logs.join('\n')).toContain('Saved Microsoft 365 OAuth credentials');
  expect(logs.join('\n')).toContain('Account: user@example.com');
  expect(logs.join('\n')).toContain('Tenant: organizations');
  expect(logs.join('\n')).toContain('Authenticated: yes');
  expect(logs.join('\n')).toContain('Cleared Microsoft 365 OAuth credentials');
});

test('help topic prints Microsoft 365 auth usage', async () => {
  const homeDir = makeTempHome();
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  const { printHelpTopic } = await import('../src/cli/help.ts');
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((line = '') => {
    logs.push(String(line));
  });

  await expect(printHelpTopic('m365')).resolves.toBe(true);

  logSpy.mockRestore();
  expect(logs.join('\n')).toContain('hybridclaw auth login microsoft365');
  expect(logs.join('\n')).toContain('MICROSOFT_365_ACCESS_TOKEN');
});
