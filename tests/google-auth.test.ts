import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HYBRIDCLAW_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_GOG_ACCESS_TOKEN = process.env.GOG_ACCESS_TOKEN;
const ORIGINAL_GOG_ACCOUNT = process.env.GOG_ACCOUNT;
const ORIGINAL_GOOGLE_WORKSPACE_CLI_TOKEN =
  process.env.GOOGLE_WORKSPACE_CLI_TOKEN;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-google-auth-'));
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

async function importFreshGoogleAuth(homeDir: string) {
  vi.resetModules();
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HOME = homeDir;
  return await import('../src/auth/google-auth.ts');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_HYBRIDCLAW_DATA_DIR);
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('GOG_ACCESS_TOKEN', ORIGINAL_GOG_ACCESS_TOKEN);
  restoreEnvVar('GOG_ACCOUNT', ORIGINAL_GOG_ACCOUNT);
  restoreEnvVar(
    'GOOGLE_WORKSPACE_CLI_TOKEN',
    ORIGINAL_GOOGLE_WORKSPACE_CLI_TOKEN,
  );
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Google Workspace runtime env mirrors an existing gws token for gog', async () => {
  const homeDir = makeTempHome();
  process.env.GOOGLE_WORKSPACE_CLI_TOKEN = 'gws-existing-token';
  process.env.GOG_ACCOUNT = 'user@example.com';
  delete process.env.GOG_ACCESS_TOKEN;
  const { resolveGoogleWorkspaceRuntimeEnv } =
    await importFreshGoogleAuth(homeDir);

  await expect(resolveGoogleWorkspaceRuntimeEnv()).resolves.toEqual({
    GOG_ACCESS_TOKEN: 'gws-existing-token',
    GOOGLE_WORKSPACE_CLI_TOKEN: 'gws-existing-token',
    GOG_ACCOUNT: 'user@example.com',
  });
});

test('Google Workspace runtime env exposes minted OAuth tokens for gog and gws', async () => {
  const homeDir = makeTempHome();
  delete process.env.GOG_ACCESS_TOKEN;
  delete process.env.GOOGLE_WORKSPACE_CLI_TOKEN;
  delete process.env.GOG_ACCOUNT;
  const { loginGoogle, resolveGoogleWorkspaceRuntimeEnv } =
    await importFreshGoogleAuth(homeDir);

  await loginGoogle({
    account: 'user@example.com',
    clientId: 'desktop-client-id',
    clientSecret: 'desktop-client-secret',
    refreshToken: 'refresh-token',
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const fetchMock = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        access_token: 'minted-access-token',
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

  await expect(resolveGoogleWorkspaceRuntimeEnv()).resolves.toEqual({
    GOG_ACCESS_TOKEN: 'minted-access-token',
    GOOGLE_WORKSPACE_CLI_TOKEN: 'minted-access-token',
    GOG_ACCOUNT: 'user@example.com',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
