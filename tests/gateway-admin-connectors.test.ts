import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  RuntimeConfig,
  RuntimeHttpRequestAuthRule,
} from '../src/config/runtime-config.js';

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
        .getGatewayAdminConnectors()
        .connectors.find((entry) => entry.id === 'hybridai'),
    ).toMatchObject({
      state: 'not_connected',
      loginUrl: 'https://hybridai.one/login?context=hybridclaw&next=/admin_api_keys',
    });

    const response = connectors.saveGatewayAdminHybridAIConnectorApiKey({
      apiKey: 'hai-test-secret-key',
    });
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

  test('completes Microsoft OAuth and configures the Graph auth route', async () => {
    const { connectors, runtimeConfig, runtimeSecrets } =
      await importFreshConnectors();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          refresh_token: 'microsoft-refresh-token',
          token_type: 'Bearer',
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
        provider: 'm365',
        account: 'user@example.com',
        tenantId: 'organizations',
        clientId: 'microsoft-client-id',
        scopes: 'offline_access User.Read Mail.Read',
      },
    });

    const url = new URL(started.authorizationUrl);
    expect(started.provider).toBe('microsoft365');
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://127.0.0.1:9090/api/connectors/oauth/callback',
    );
    expect(url.searchParams.get('code_challenge')).toBeTruthy();

    await expect(
      connectors.completeGatewayAdminConnectorOAuthCallback({
        state: started.state,
        code: 'authorization-code',
      }),
    ).resolves.toEqual({
      provider: 'microsoft365',
      name: 'Microsoft 365',
    });

    expect(runtimeSecrets.readStoredRuntimeSecret('MICROSOFT_365_REFRESH_TOKEN')).toBe(
      'microsoft-refresh-token',
    );
    expect(runtimeConfig.tools.httpRequest.authRules).toContainEqual({
      urlPrefix: 'https://graph.microsoft.com/',
      header: 'Authorization',
      prefix: 'Bearer',
      secret: { source: 'microsoft-oauth' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      'code_verifier=',
    );
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
      await connectors.getGatewayAdminConnectorsWithPlatformState();

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
