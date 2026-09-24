import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  RuntimeConfig,
  RuntimeHttpRequestAuthRule,
} from '../src/config/runtime-config.js';
import { resolveAdminRbacAction } from '../src/security/admin-rbac.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DATA_DIR = process.env.HYBRIDCLAW_DATA_DIR;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-admin-connectors-'),
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

async function importFreshConnectors(options?: {
  authRules?: RuntimeHttpRequestAuthRule[];
}) {
  vi.resetModules();
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DATA_DIR = homeDir;
  process.env.HYBRIDCLAW_MASTER_KEY = 'a'.repeat(64);

  const runtimeConfig = {
    ops: {
      logLevel: 'info',
    },
    tools: {
      httpRequest: {
        authRules: options?.authRules ? [...options.authRules] : [],
      },
    },
  } as RuntimeConfig;
  const refreshRuntimeSecretsFromEnv = vi.fn();

  vi.doMock('../src/config/config.js', () => ({
    HYBRIDAI_API_KEY: '',
    HYBRIDAI_BASE_URL: 'https://hybridai.one',
    MissingRequiredEnvVarError: class MissingRequiredEnvVarError extends Error {
      constructor(name: string) {
        super(`Missing required env var: ${name}`);
      }
    },
    refreshRuntimeSecretsFromEnv,
  }));
  vi.doMock('../src/config/runtime-config.js', async () => {
    const actual = await vi.importActual<
      typeof import('../src/config/runtime-config.js')
    >('../src/config/runtime-config.js');
    return {
      ...actual,
      getRuntimeConfig: () => runtimeConfig,
      updateRuntimeConfig: (
        updater: (draft: RuntimeConfig) => void,
      ): RuntimeConfig => {
        updater(runtimeConfig);
        return runtimeConfig;
      },
    };
  });

  const connectors = await import(
    '../src/gateway/gateway-admin-connectors.ts'
  );
  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  return {
    connectors,
    homeDir,
    refreshRuntimeSecretsFromEnv,
    runtimeConfig,
    runtimeSecrets,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_DATA_DIR', ORIGINAL_DATA_DIR);
  restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_MASTER_KEY);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gateway admin connectors', () => {
  test('reports HybridAI status and stores an API key without returning it', async () => {
    const { connectors, refreshRuntimeSecretsFromEnv, runtimeSecrets } =
      await importFreshConnectors();

    expect(
      connectors
        .getGatewayAdminConnectors({ authPayload: null })
        .connectors.find((entry) => entry.id === 'hybridai'),
    ).toMatchObject({
      state: 'not_connected',
      loginUrl: 'https://hybridai.one/login?context=hybridclaw&next=/admin_api_keys',
    });

    const response = connectors.saveGatewayAdminHybridAIConnectorApiKey(
      { apiKey: 'hai-test-secret-key' },
      { authPayload: null },
    );
    const hybridai = response.connectors.find(
      (entry) => entry.id === 'hybridai',
    );

    expect(hybridai).toMatchObject({
      state: 'connected',
      detail: expect.stringContaining('hai-'),
    });
    expect(JSON.stringify(response)).not.toContain('hai-test-secret-key');
    expect(runtimeSecrets.readStoredRuntimeSecret('HYBRIDAI_API_KEY')).toBe(
      'hai-test-secret-key',
    );
    expect(refreshRuntimeSecretsFromEnv).toHaveBeenCalledTimes(1);
  });

  const allCredentialActions = ['secret.overwrite', 'secret.unset'];

  test.each([
    {
      caller: 'a legacy bearer token or loopback session',
      authPayload: null,
      actions: allCredentialActions,
    },
    {
      caller: 'an unscoped HybridAI session',
      authPayload: { typ: 'session', actor: 'admin-user' },
      actions: allCredentialActions,
    },
    {
      caller: 'admin.viewer',
      authPayload: { role: 'admin.viewer' },
      actions: [],
    },
    {
      caller: 'admin.integrations_manager',
      authPayload: { role: 'admin.integrations_manager' },
      actions: [],
    },
    {
      caller: 'admin:operator',
      authPayload: { roles: ['admin:operator'] },
      actions: [],
    },
    {
      caller: 'admin.security_manager',
      authPayload: { role: 'admin.security_manager' },
      actions: allCredentialActions,
    },
    {
      caller: 'admin:secret-manager',
      authPayload: { roles: ['admin:secret-manager'] },
      actions: allCredentialActions,
    },
    {
      caller: 'an overwrite-only API token',
      authPayload: { actions: ['admin.connectors.read', 'secret.overwrite'] },
      actions: ['secret.overwrite'],
    },
  ])(
    'lists the connector credential actions held by $caller',
    async ({ authPayload, actions }) => {
      const { connectors } = await importFreshConnectors();

      const response =
        await connectors.getGatewayAdminConnectorsWithPlatformState({
          authPayload,
        });

      expect(response.actions).toEqual(actions);
    },
  );

  test('keeps the caller credential actions on key save and logout responses', async () => {
    const { connectors } = await importFreshConnectors();

    const saved = connectors.saveGatewayAdminHybridAIConnectorApiKey(
      { apiKey: 'hai-test-secret-key' },
      { authPayload: { actions: ['secret.overwrite'] } },
    );
    expect(saved.actions).toEqual(['secret.overwrite']);

    const loggedOut = connectors.logoutGatewayAdminConnector(
      { provider: 'hybridai' },
      { authPayload: { role: 'admin.security_manager' } },
    );
    expect(loggedOut.actions).toEqual(allCredentialActions);
  });

  test('advertises exactly the actions the admin route gate requires for connector credentials', async () => {
    const { connectors } = await importFreshConnectors();
    const gatedActions = [
      resolveAdminRbacAction('/api/admin/connectors/hybridai/key', 'PUT'),
      resolveAdminRbacAction('/api/admin/connectors/oauth/start', 'POST'),
      resolveAdminRbacAction('/api/admin/connectors/logout', 'POST'),
    ];

    expect(
      new Set(
        connectors.getGatewayAdminConnectors({ authPayload: null }).actions,
      ),
    ).toEqual(new Set(gatedActions));
  });

  test('starts Microsoft 365 OAuth through HybridAI as the API key owner', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          authorization_url: 'https://microsoft.test/authorize',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const started = await connectors.startGatewayAdminConnectorOAuth({
      requestBaseUrl: 'http://127.0.0.1:9090',
      body: {
        provider: 'microsoft365',
      },
    });

    expect(started).toMatchObject({
      provider: 'microsoft365',
      authorizationUrl: 'https://microsoft.test/authorize',
      state: '',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/oauth/authorize/microsoft365',
    );
    const init = request as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      return_to: 'http://127.0.0.1:9090/admin/connectors',
    });
  });

  test('starts GitHub OAuth through HybridAI as the API key owner', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          authorization_url: 'https://github.test/install',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const started = await connectors.startGatewayAdminConnectorOAuth({
      requestBaseUrl: 'http://127.0.0.1:9090',
      body: {
        provider: 'github',
      },
    });

    expect(started).toMatchObject({
      provider: 'github',
      authorizationUrl: 'https://github.test/install',
      state: '',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/oauth/authorize/github',
    );
    const init = request as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      return_to: 'http://127.0.0.1:9090/admin/connectors',
    });
  });

  test('tests HybridAI with the configured platform API key', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ bots: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      connectors.testGatewayAdminConnector({ provider: 'hybridai' }),
    ).resolves.toMatchObject({
      provider: 'hybridai',
      name: 'HybridAI',
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/bot-management/bots',
    );
    expect(new Headers((request as RequestInit).headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
  });

  test('tests GitHub through the HybridAI connector directory', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          connectors: [{ id: 'github', connected: true }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      connectors.testGatewayAdminConnector({ provider: 'github' }),
    ).resolves.toEqual({
      provider: 'github',
      name: 'GitHub',
      ok: true,
      message: 'GitHub is connected for this HybridAI account.',
    });
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/directory',
    );
    expect(new Headers((request as RequestInit).headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
  });

  test('tests Microsoft 365 through the HybridAI connector directory', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          connectors: [{ id: 'microsoft365', connected: true }],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      connectors.testGatewayAdminConnector({ provider: 'microsoft365' }),
    ).resolves.toEqual({
      provider: 'microsoft365',
      name: 'Microsoft 365',
      ok: true,
      message: 'Microsoft 365 is connected for this HybridAI account.',
    });
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/directory',
    );
    expect(new Headers((request as RequestInit).headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
  });

  test('marks GitHub connected from the HybridAI connector directory', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          connectors: [
            {
              id: 'github',
              connected: true,
              account: 'HybridAIOne',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const response =
      await connectors.getGatewayAdminConnectorsWithPlatformState({
        authPayload: null,
      });

    expect(response.connectors.find((entry) => entry.id === 'github')).toMatchObject(
      {
        state: 'connected',
        account: 'HybridAIOne',
        detail: 'Connected through HybridAI.',
      },
    );
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/directory',
    );
    expect(new Headers((request as RequestInit).headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
  });

  test('marks Microsoft 365 connected from the HybridAI connector directory', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    runtimeSecrets.saveNamedRuntimeSecrets({
      HYBRIDAI_API_KEY: 'hai-test-secret-key',
    });
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          connectors: [
            {
              id: 'windows365',
              connected: true,
              account: 'user@example.com',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const response =
      await connectors.getGatewayAdminConnectorsWithPlatformState({
        authPayload: null,
      });

    expect(
      response.connectors.find((entry) => entry.id === 'microsoft365'),
    ).toMatchObject({
      state: 'connected',
      account: 'user@example.com',
      detail: 'Connected through HybridAI.',
    });
    const [url, request] = fetchMock.mock.calls[0] || [];
    expect(String(url)).toBe(
      'https://hybridai.one/api/v1/connectors/directory',
    );
    expect(new Headers((request as RequestInit).headers).get('Authorization')).toBe(
      'Bearer hai-test-secret-key',
    );
  });

  test('rejects Google OAuth start when account and client credentials are missing', async () => {
    const { connectors } = await importFreshConnectors();

    await expect(
      connectors.startGatewayAdminConnectorOAuth({
        requestBaseUrl: 'http://127.0.0.1:9090',
        body: {
          provider: 'google',
        },
      }),
    ).rejects.toThrow('Google account email is required.');
  });

  test('exposes the console-origin OAuth redirect URI for a remote Web client', async () => {
    const { connectors } = await importFreshConnectors();

    const listed = await connectors.getGatewayAdminConnectorsWithPlatformState({
      requestBaseUrl: 'http://console.example',
      authPayload: null,
    });
    expect(listed.oauthRedirectUri).toBe(
      'http://console.example/api/connectors/oauth/callback',
    );
    expect(
      connectors.getGatewayAdminConnectors({ authPayload: null })
        .oauthRedirectUri,
    ).toBeNull();

    const started = await connectors.startGatewayAdminConnectorOAuth({
      requestBaseUrl: 'http://console.example',
      body: {
        provider: 'google',
        account: 'user@example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });
    const redirectUri = new URL(started.authorizationUrl).searchParams.get(
      'redirect_uri',
    );
    expect(redirectUri).toBe(
      'http://console.example/api/connectors/oauth/callback',
    );
  });

  test('omits the redirect URI for a local gateway (loopback Desktop flow)', async () => {
    const { connectors } = await importFreshConnectors();

    const localhost =
      await connectors.getGatewayAdminConnectorsWithPlatformState({
        requestBaseUrl: 'http://localhost:5000',
        authPayload: null,
      });
    expect(localhost.oauthRedirectUri).toBeNull();

    const loopbackIp =
      await connectors.getGatewayAdminConnectorsWithPlatformState({
        requestBaseUrl: 'http://127.0.0.1:5000',
        authPayload: null,
      });
    expect(loopbackIp.oauthRedirectUri).toBeNull();
  });

  test('completes the Google loopback flow for a local gateway', async () => {
    const { connectors, runtimeSecrets } = await importFreshConnectors();
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ refresh_token: 'refresh-abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const started = await connectors.startGatewayAdminConnectorOAuth({
      requestBaseUrl: 'http://localhost:5000',
      body: {
        provider: 'google',
        account: 'user@example.com',
        clientId: 'client-id',
        clientSecret: 'client-secret',
      },
    });

    const authUrl = new URL(started.authorizationUrl);
    const redirectUri = authUrl.searchParams.get('redirect_uri') || '';
    expect(redirectUri).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth2\/callback$/,
    );

    // Simulate Google redirecting the browser back to the loopback listener.
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', authUrl.searchParams.get('state') || '');
    callback.searchParams.set('code', 'auth-code');
    await new Promise<void>((resolve, reject) => {
      http
        .get(callback.toString(), (res) => {
          res.resume();
          res.on('end', resolve);
        })
        .on('error', reject);
    });

    await vi.waitFor(() => {
      const google = connectors
        .getGatewayAdminConnectors({ authPayload: null })
        .connectors.find((entry) => entry.id === 'google');
      expect(google?.state).toBe('connected');
    });
    expect(
      runtimeSecrets.readStoredRuntimeSecret('GOOGLE_OAUTH_REFRESH_TOKEN'),
    ).toBe('refresh-abc');
  });

  test('rejects connector OAuth callbacks with unknown state', async () => {
    const { connectors } = await importFreshConnectors();

    await expect(
      connectors.completeGatewayAdminConnectorOAuthCallback({
        state: 'missing-state',
        code: 'authorization-code',
      }),
    ).rejects.toThrow('Unknown or expired connector OAuth state');
  });
});
