import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const ORIGINAL_SSH_CONNECTION = process.env.SSH_CONNECTION;
const ORIGINAL_SSH_CLIENT = process.env.SSH_CLIENT;
const ORIGINAL_SSH_TTY = process.env.SSH_TTY;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_CONTAINER = process.env.CONTAINER;
const ORIGINAL_DOCKER_CONTAINER = process.env.DOCKER_CONTAINER;
const ORIGINAL_KUBERNETES_SERVICE_HOST = process.env.KUBERNETES_SERVICE_HOST;
const ORIGINAL_DISPLAY = process.env.DISPLAY;
const ORIGINAL_WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-codex-auth-'));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

async function importFreshCodexAuth(
  homeDir: string,
  options?: {
    readlineQuestion?: () => Promise<string>;
    spawnMock?: ReturnType<typeof vi.fn>;
    httpCreateServerMock?: ReturnType<typeof vi.fn>;
  },
) {
  process.env.HOME = homeDir;
  vi.resetModules();
  if (options?.readlineQuestion) {
    vi.doMock('node:readline/promises', () => ({
      default: {
        createInterface: () => ({
          question: options.readlineQuestion,
          close: vi.fn(),
        }),
      },
    }));
  }
  if (options?.spawnMock) {
    vi.doMock('node:child_process', () => ({
      spawn: options.spawnMock,
    }));
  }
  if (options?.httpCreateServerMock) {
    vi.doMock('node:http', () => ({
      createServer: options.httpCreateServerMock,
      default: {
        createServer: options.httpCreateServerMock,
      },
    }));
  }
  return import('../src/auth/codex-auth.ts');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('node:child_process');
  vi.doUnmock('node:http');
  vi.doUnmock('node:readline/promises');
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('CODEX_HOME', ORIGINAL_CODEX_HOME);
  restoreEnvVar('SSH_CONNECTION', ORIGINAL_SSH_CONNECTION);
  restoreEnvVar('SSH_CLIENT', ORIGINAL_SSH_CLIENT);
  restoreEnvVar('SSH_TTY', ORIGINAL_SSH_TTY);
  restoreEnvVar('CI', ORIGINAL_CI);
  restoreEnvVar('CONTAINER', ORIGINAL_CONTAINER);
  restoreEnvVar('DOCKER_CONTAINER', ORIGINAL_DOCKER_CONTAINER);
  restoreEnvVar('KUBERNETES_SERVICE_HOST', ORIGINAL_KUBERNETES_SERVICE_HOST);
  restoreEnvVar('DISPLAY', ORIGINAL_DISPLAY);
  restoreEnvVar('WAYLAND_DISPLAY', ORIGINAL_WAYLAND_DISPLAY);
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
});

describe('codex auth JWT helpers', () => {
  it('extracts direct, namespaced, and organization fallback account IDs', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);

    const directJwt = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      chatgpt_account_id: 'acct_direct',
    });
    const nestedJwt = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_nested',
      },
    });
    const orgFallbackJwt = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      organizations: [{ id: 'org_fallback' }],
    });

    expect(codexAuth.extractAccountIdFromJwt(directJwt)).toBe('acct_direct');
    expect(codexAuth.extractAccountIdFromJwt(nestedJwt)).toBe('acct_nested');
    expect(codexAuth.extractAccountIdFromJwt(orgFallbackJwt)).toBe(
      'org_fallback',
    );
    expect(codexAuth.extractExpiresAtFromJwt(directJwt)).toBeGreaterThan(
      Date.now(),
    );
  });

  it('builds the browser auth URL with localhost redirect and simplified flow', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);

    const redirectUri = codexAuth.buildBrowserRedirectUri();
    const authUrl = new URL(
      codexAuth.buildAuthUrl({
        clientId: codexAuth.CODEX_AUTH_CLIENT_ID,
        redirectUri,
        pkce: {
          verifier: 'verifier-value',
          challenge: 'challenge-value',
        },
        state: 'state-value',
      }),
    );

    expect(redirectUri).toBe('http://localhost:1455/auth/callback');
    expect(authUrl.origin + authUrl.pathname).toBe(
      'https://auth.openai.com/oauth/authorize',
    );
    expect(authUrl.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(authUrl.searchParams.get('response_type')).toBe('code');
    expect(authUrl.searchParams.get('code_challenge')).toBe('challenge-value');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBe('state-value');
    expect(authUrl.searchParams.get('id_token_add_organizations')).toBe(
      'true',
    );
    expect(
      authUrl.searchParams.get(codexAuth.CODEX_SIMPLIFIED_FLOW_PARAM),
    ).toBe('true');
    expect(authUrl.searchParams.get('originator')).toBe('hybridclaw');
  });

  it('throws typed errors for malformed JWT payloads and missing required claims', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const noAccountIdJwt = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: 'user_123',
    });
    const noExpJwt = makeJwt({
      chatgpt_account_id: 'acct_missing_exp',
    });

    expect(() => codexAuth.extractAccountIdFromJwt('not-a-jwt')).toThrowError(
      expect.objectContaining({
        code: 'codex_auth_missing_access_token',
      }),
    );
    expect(() => codexAuth.extractAccountIdFromJwt(noAccountIdJwt)).toThrowError(
      expect.objectContaining({
        code: 'codex_account_id_missing',
      }),
    );
    expect(() => codexAuth.extractExpiresAtFromJwt(noExpJwt)).toThrowError(
      expect.objectContaining({
        code: 'codex_auth_missing_access_token',
      }),
    );
  });
});

describe('codex auth store I/O', () => {
  it('writes the isolated auth store with owner-only permissions', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      chatgpt_account_id: 'acct_123',
    });
    const storePath = codexAuth.saveCodexAuthStore(
      {
        version: 1,
        credentials: {
          accessToken,
          refreshToken: 'refresh_123',
          accountId: 'acct_123',
          expiresAt: codexAuth.extractExpiresAtFromJwt(accessToken),
          provider: 'openai-codex',
          authMethod: 'oauth',
          source: 'browser-pkce',
          lastRefresh: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      },
      homeDir,
    );

    const stored = codexAuth.loadCodexAuthStore(homeDir);
    const mode = fs.statSync(storePath).mode & 0o777;

    expect(storePath).toBe(path.join(homeDir, '.hybridclaw', 'codex-auth.json'));
    expect(stored.credentials?.accountId).toBe('acct_123');
    expect(mode).toBe(0o600);
  });

  it('exposes request headers with content type via resolveCodexCredentials', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 600,
      chatgpt_account_id: 'acct_headers',
    });

    codexAuth.saveCodexAuthStore(
      {
        version: 1,
        credentials: {
          accessToken,
          refreshToken: 'refresh_headers',
          accountId: 'acct_headers',
          expiresAt: codexAuth.extractExpiresAtFromJwt(accessToken),
          provider: 'openai-codex',
          authMethod: 'oauth',
          source: 'browser-pkce',
          lastRefresh: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      },
      homeDir,
    );

    const resolved = await codexAuth.resolveCodexCredentials();
    expect(resolved.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Chatgpt-Account-Id': 'acct_headers',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'hybridclaw',
    });
  });
});

describe('codex auth refresh', () => {
  it('refreshes expired credentials under a stale lock and persists rotated tokens', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const expiredToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 300,
      chatgpt_account_id: 'acct_old',
    });
    const refreshedToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'acct_new',
    });

    codexAuth.saveCodexAuthStore(
      {
        version: 1,
        credentials: {
          accessToken: expiredToken,
          refreshToken: 'refresh_old',
          accountId: 'acct_old',
          expiresAt: codexAuth.extractExpiresAtFromJwt(expiredToken),
          provider: 'openai-codex',
          authMethod: 'oauth',
          source: 'browser-pkce',
          lastRefresh: new Date(0).toISOString(),
        },
        updatedAt: new Date(0).toISOString(),
      },
      homeDir,
    );

    const lockPath = codexAuth.codexAuthLockPath(homeDir);
    fs.writeFileSync(lockPath, 'stale\n', 'utf-8');
    const staleDate = new Date(Date.now() - 45_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(String(init?.body)).toBe(
        'client_id=app_EMoamEEZ73f0CkXaXp7hrann&grant_type=refresh_token&refresh_token=refresh_old',
      );
      return new Response(
        JSON.stringify({
          access_token: refreshedToken,
          refresh_token: 'refresh_new',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await codexAuth.ensureFreshCredentials(homeDir);
    const stored = codexAuth.loadCodexAuthStore(homeDir);

    expect(result.refreshed).toBe(true);
    expect(result.credentials.accountId).toBe('acct_new');
    expect(stored.credentials?.refreshToken).toBe('refresh_new');
    expect(stored.credentials?.accountId).toBe('acct_new');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('marks 401 refresh failures as relogin-required', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const expiredToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) - 300,
      chatgpt_account_id: 'acct_old',
    });

    codexAuth.saveCodexAuthStore(
      {
        version: 1,
        credentials: {
          accessToken: expiredToken,
          refreshToken: 'refresh_old',
          accountId: 'acct_old',
          expiresAt: codexAuth.extractExpiresAtFromJwt(expiredToken),
          provider: 'openai-codex',
          authMethod: 'oauth',
          source: 'browser-pkce',
          lastRefresh: new Date(0).toISOString(),
        },
        updatedAt: new Date(0).toISOString(),
      },
      homeDir,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({ error: 'invalid_grant' }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );

    await expect(codexAuth.ensureFreshCredentials(homeDir)).rejects.toMatchObject({
      code: 'codex_refresh_failed',
      reloginRequired: true,
    });
  });
});

describe('codex auth device code flow', () => {
  it('uses server-provided device auth fields and code verifier', async () => {
    vi.useFakeTimers();
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'acct_device',
    });

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/accounts/deviceauth/usercode')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        });
        return new Response(
          JSON.stringify({
            device_auth_id: 'device_auth_123',
            user_code: 'USER-1234',
            verification_uri: 'https://auth.openai.com/activate',
            interval: 1,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      if (url.endsWith('/api/accounts/deviceauth/token')) {
        expect(init?.method).toBe('POST');
        expect(init?.headers).toMatchObject({
          'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(init?.body))).toEqual({
          device_auth_id: 'device_auth_123',
          user_code: 'USER-1234',
        });
        return new Response(
          JSON.stringify({
            authorization_code: 'authorization_code_123',
            code_verifier: 'server_verifier_123',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      expect(url.endsWith('/oauth/token')).toBe(true);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      const params = new URLSearchParams(String(init?.body || ''));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('authorization_code_123');
      expect(params.get('redirect_uri')).toBe(
        'https://auth.openai.com/deviceauth/callback',
      );
      expect(params.get('code_verifier')).toBe('server_verifier_123');
      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh_device',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const loginPromise = codexAuth.loginWithDeviceCode(homeDir);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await loginPromise;
    const stored = codexAuth.loadCodexAuthStore(homeDir);

    expect(result.credentials.accountId).toBe('acct_device');
    expect(stored.credentials?.refreshToken).toBe('refresh_device');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe('codex auth browser flow', () => {
  it('accepts the local callback server response and exchanges the code with PKCE', async () => {
    const homeDir = makeTempHome();
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'acct_browser',
    });
    let callbackHandler:
      | ((req: { url?: string }, res: {
          statusCode: number;
          setHeader: (name: string, value: string) => void;
          end: (body?: string) => void;
        }) => void)
      | null = null;
    const spawnMock = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      process.nextTick(() => child.emit('spawn'));
      return child;
    });
    const httpServerMock = vi.fn(
      (
        handler: (req: { url?: string }, res: {
          statusCode: number;
          setHeader: (name: string, value: string) => void;
          end: (body?: string) => void;
        }) => void,
      ) => {
        callbackHandler = handler;
        const server = new EventEmitter() as EventEmitter & {
          listen: (port: number, host: string) => void;
          close: () => void;
        };
        server.listen = vi.fn();
        server.close = vi.fn();
        return server;
      },
    );
    const codexAuth = await importFreshCodexAuth(homeDir, {
      readlineQuestion: () => new Promise<string>(() => {}),
      spawnMock,
      httpCreateServerMock: httpServerMock,
    });

    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url.endsWith('/oauth/token')).toBe(true);
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      const params = new URLSearchParams(String(init?.body || ''));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('browser_code_123');
      expect(params.get('redirect_uri')).toBe(
        'http://localhost:1455/auth/callback',
      );
      expect(params.get('client_id')).toBe(codexAuth.CODEX_AUTH_CLIENT_ID);
      expect(params.get('code_verifier')).toBeTruthy();

      return new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh_browser',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const loginPromise = codexAuth.loginWithBrowserPkce(homeDir);
    const authUrlLine = await vi.waitFor(() => {
      const line = consoleLog.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.startsWith('Auth URL: '));
      expect(line).toBeTruthy();
      return line as string;
    });
    const authUrl = new URL(authUrlLine.slice('Auth URL: '.length));
    await vi.waitFor(() => {
      expect(httpServerMock).toHaveBeenCalledTimes(1);
    });
    expect(callbackHandler).toBeTruthy();

    let callbackBody = '';
    const responseHeaders: Record<string, string> = {};
    callbackHandler?.(
      {
        url: `/auth/callback?code=browser_code_123&state=${authUrl.searchParams.get('state') || ''}`,
      },
      {
        statusCode: 200,
        setHeader(name: string, value: string) {
          responseHeaders[name] = value;
        },
        end(body?: string) {
          callbackBody = body || '';
        },
      },
    );

    const result = await loginPromise;
    const stored = codexAuth.loadCodexAuthStore(homeDir);

    expect(callbackBody).toContain('HybridClaw Codex login complete');
    expect(responseHeaders['Content-Type']).toBe('text/html; charset=utf-8');
    expect(result.credentials.accountId).toBe('acct_browser');
    expect(stored.credentials?.source).toBe('browser-pkce');
    expect(stored.credentials?.refreshToken).toBe('refresh_browser');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('codex auth CLI import', () => {
  it('imports credentials from the Codex CLI auth store without writing back', async () => {
    const homeDir = makeTempHome();
    const codexHome = path.join(homeDir, 'codex-home');
    const accessToken = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 3_600,
      chatgpt_account_id: 'acct_import',
    });

    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      `${JSON.stringify(
        {
          credentials: {
            access_token: accessToken,
            refresh_token: 'refresh_import',
            account_id: 'acct_import',
          },
          last_refresh: '2026-03-06T12:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );

    process.env.CODEX_HOME = codexHome;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const codexAuth = await importFreshCodexAuth(homeDir, {
      readlineQuestion: () => Promise.resolve('yes'),
    });

    const result = await codexAuth.importCodexCliCredentials(homeDir);
    const stored = codexAuth.loadCodexAuthStore(homeDir);
    const importedRaw = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf-8');

    expect(result.importedFrom).toBe(path.join(codexHome, 'auth.json'));
    expect(result.credentials.source).toBe('codex-cli-import');
    expect(stored.credentials?.accountId).toBe('acct_import');
    expect(stored.credentials?.source).toBe('codex-cli-import');
    expect(importedRaw).toContain('"refresh_token": "refresh_import"');
  });
});

describe('codex auth login method auto-selection', () => {
  it('prefers device code in headless or remote environments', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);

    process.env.SSH_CONNECTION = '127.0.0.1 22 127.0.0.1 55555';

    expect(codexAuth.selectDefaultCodexLoginMethod()).toBe('device-code');
  });

  it('prefers browser login when a local interactive environment is available', async () => {
    const homeDir = makeTempHome();
    const codexAuth = await importFreshCodexAuth(homeDir);

    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    delete process.env.CI;
    delete process.env.CONTAINER;
    delete process.env.DOCKER_CONTAINER;
    delete process.env.KUBERNETES_SERVICE_HOST;
    if (process.platform === 'linux') {
      process.env.DISPLAY = ':0';
    }

    expect(codexAuth.selectDefaultCodexLoginMethod()).toBe('browser-pkce');
  });
});
