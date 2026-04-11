import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CWD = process.cwd();

function makeTempHome(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-google-workspace-auth-'),
  );
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

async function importFreshGoogleWorkspaceAuth(homeDir: string) {
  process.env.HOME = homeDir;
  process.chdir(homeDir);
  vi.resetModules();
  return import('../src/auth/google-workspace-auth.ts');
}

function writeClientSecretFile(homeDir: string): string {
  const filePath = path.join(homeDir, 'client_secret.json');
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        installed: {
          client_id: 'client-id.apps.googleusercontent.com',
          client_secret: 'client-secret',
          auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  return filePath;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  process.chdir(ORIGINAL_CWD);
});

describe('Google Workspace auth', () => {
  it('stores the Google OAuth client secret in the runtime secret store', async () => {
    const homeDir = makeTempHome();
    const googleWorkspaceAuth = await importFreshGoogleWorkspaceAuth(homeDir);
    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    const clientSecretPath = writeClientSecretFile(homeDir);

    const result =
      googleWorkspaceAuth.saveGoogleWorkspaceClientSecretFile(clientSecretPath);

    expect(result.path).toBe(
      path.join(homeDir, '.hybridclaw', 'credentials.json'),
    );
    expect(result.clientId).toBe('client-id.apps.googleusercontent.com');
    expect(
      runtimeSecrets.readStoredRuntimeSecret(
        googleWorkspaceAuth.GOOGLE_WORKSPACE_CLIENT_SECRET_KEY,
      ),
    ).toContain('client-id.apps.googleusercontent.com');
    expect(googleWorkspaceAuth.getGoogleWorkspaceAuthStatus()).toMatchObject({
      authenticated: false,
      clientConfigured: true,
      pendingAuthorization: false,
    });
  });

  it('creates and stores a pending PKCE session when printing the auth URL', async () => {
    const homeDir = makeTempHome();
    const googleWorkspaceAuth = await importFreshGoogleWorkspaceAuth(homeDir);
    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    googleWorkspaceAuth.saveGoogleWorkspaceClientSecretFile(
      writeClientSecretFile(homeDir),
    );

    const result = googleWorkspaceAuth.startGoogleWorkspaceAuth();
    const authUrl = new URL(result.authUrl);
    const pendingRaw = runtimeSecrets.readStoredRuntimeSecret(
      googleWorkspaceAuth.GOOGLE_WORKSPACE_PENDING_AUTH_KEY,
    );

    expect(result.path).toBe(
      path.join(homeDir, '.hybridclaw', 'credentials.json'),
    );
    expect(result.redirectUri).toBe(
      googleWorkspaceAuth.GOOGLE_WORKSPACE_REDIRECT_URI,
    );
    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(authUrl.searchParams.get('client_id')).toBe(
      'client-id.apps.googleusercontent.com',
    );
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    expect(authUrl.searchParams.get('prompt')).toBe('consent');
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      googleWorkspaceAuth.GOOGLE_WORKSPACE_REDIRECT_URI,
    );
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(JSON.parse(pendingRaw || '{}')).toMatchObject({
      redirectUri: googleWorkspaceAuth.GOOGLE_WORKSPACE_REDIRECT_URI,
    });
  });

  it('exchanges a pasted redirect URL for a refreshable token and clears pending state', async () => {
    const homeDir = makeTempHome();
    const googleWorkspaceAuth = await importFreshGoogleWorkspaceAuth(homeDir);
    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    googleWorkspaceAuth.saveGoogleWorkspaceClientSecretFile(
      writeClientSecretFile(homeDir),
    );
    googleWorkspaceAuth.startGoogleWorkspaceAuth();
    const pending = JSON.parse(
      runtimeSecrets.readStoredRuntimeSecret(
        googleWorkspaceAuth.GOOGLE_WORKSPACE_PENDING_AUTH_KEY,
      ) || '{}',
    ) as { state: string };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'ya29.access-token',
          refresh_token: '1//refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: googleWorkspaceAuth.GOOGLE_WORKSPACE_SCOPES.join(' '),
        }),
      })),
    );

    const result = await googleWorkspaceAuth.exchangeGoogleWorkspaceAuthCode(
      `http://localhost:1/?code=auth-code&state=${pending.state}`,
    );
    const status = googleWorkspaceAuth.getGoogleWorkspaceAuthStatus();

    expect(result.path).toBe(
      path.join(homeDir, '.hybridclaw', 'credentials.json'),
    );
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.scopes).toContain('https://www.googleapis.com/auth/calendar');
    expect(status).toMatchObject({
      authenticated: true,
      clientConfigured: true,
      pendingAuthorization: false,
      refreshTokenConfigured: true,
    });
  });

  it('rejects redirect URLs with a mismatched state', async () => {
    const homeDir = makeTempHome();
    const googleWorkspaceAuth = await importFreshGoogleWorkspaceAuth(homeDir);
    googleWorkspaceAuth.saveGoogleWorkspaceClientSecretFile(
      writeClientSecretFile(homeDir),
    );
    googleWorkspaceAuth.startGoogleWorkspaceAuth();

    await expect(
      googleWorkspaceAuth.exchangeGoogleWorkspaceAuthCode(
        'http://localhost:1/?code=auth-code&state=wrong-state',
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'google_workspace_state_mismatch',
      }),
    );
  });

  it('refreshes an expired access token from the stored refresh token', async () => {
    const homeDir = makeTempHome();
    const googleWorkspaceAuth = await importFreshGoogleWorkspaceAuth(homeDir);
    const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
    googleWorkspaceAuth.saveGoogleWorkspaceClientSecretFile(
      writeClientSecretFile(homeDir),
    );
    runtimeSecrets.saveNamedRuntimeSecrets({
      [googleWorkspaceAuth.GOOGLE_WORKSPACE_TOKEN_KEY]: JSON.stringify({
        accessToken: 'ya29.expired',
        refreshToken: '1//refresh-token',
        tokenType: 'Bearer',
        scopes: [...googleWorkspaceAuth.GOOGLE_WORKSPACE_SCOPES],
        expiresAt: Date.now() - 60_000,
        updatedAt: new Date().toISOString(),
      }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          access_token: 'ya29.refreshed',
          expires_in: 1800,
          token_type: 'Bearer',
        }),
      })),
    );

    const result =
      await googleWorkspaceAuth.ensureFreshGoogleWorkspaceAccessToken();

    expect(result).toMatchObject({
      accessToken: 'ya29.refreshed',
      refreshed: true,
    });
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });
});
