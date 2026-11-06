import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function mockHybridAIAuth(apiKey: string | null): void {
  vi.doMock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<object>();
    return { ...actual, HYBRIDAI_BASE_URL: 'https://hybridai.test' };
  });
  vi.doMock('../src/auth/hybridai-auth.js', async () => {
    const { MissingRequiredEnvVarError } = await import(
      '../src/config/config.js'
    );
    return {
      getHybridAIApiKey: () => {
        if (!apiKey) throw new MissingRequiredEnvVarError('HYBRIDAI_API_KEY');
        return apiKey;
      },
    };
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HybridAI GitHub connector token', () => {
  test('mints a token from the platform and caches it until expiry', async () => {
    mockHybridAIAuth('hai-key');
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        access_token: 'ghs_minted',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { resolveGitHubConnectorAccessToken } = await import(
      '../src/auth/github-connector-auth.js'
    );

    await expect(resolveGitHubConnectorAccessToken()).resolves.toEqual({
      accessToken: 'ghs_minted',
      source: 'github-connector',
    });
    await resolveGitHubConnectorAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hybridai.test/api/v1/connectors/github/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer hai-key' }),
      }),
    );
  });

  test('refreshes tokens that are about to expire', async () => {
    mockHybridAIAuth('hai-key');
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { access_token: 'ghs_short', expires_in: 30 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { resolveGitHubConnectorAccessToken } = await import(
      '../src/auth/github-connector-auth.js'
    );
    await resolveGitHubConnectorAccessToken();
    await resolveGitHubConnectorAccessToken();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('returns null when the connector is not connected', async () => {
    mockHybridAIAuth('hai-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(404, { error: 'not connected' })),
    );

    const { resolveGitHubConnectorAccessToken } = await import(
      '../src/auth/github-connector-auth.js'
    );
    await expect(resolveGitHubConnectorAccessToken()).resolves.toBeNull();
  });

  test('returns null without calling the platform when HybridAI is not connected', async () => {
    mockHybridAIAuth(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { resolveGitHubConnectorAccessToken } = await import(
      '../src/auth/github-connector-auth.js'
    );
    await expect(resolveGitHubConnectorAccessToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('surfaces unexpected platform errors', async () => {
    mockHybridAIAuth('hai-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(502, { message: 'upstream down' })),
    );

    const { resolveGitHubConnectorAccessToken } = await import(
      '../src/auth/github-connector-auth.js'
    );
    await expect(resolveGitHubConnectorAccessToken()).rejects.toThrow(
      'upstream down',
    );
  });
});

describe('gateway git credential endpoint', () => {
  function setup(params: {
    connectorToken: string | null;
    storedSecrets?: Record<string, string>;
  }): { recordAuditEvent: ReturnType<typeof vi.fn>; workspacePath: string } {
    const workspacePath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-git-credential-'),
    );
    const recordAuditEvent = vi.fn();
    vi.doMock('../src/infra/ipc.js', () => ({
      agentWorkspaceDir: () => workspacePath,
    }));
    vi.doMock('../src/audit/audit-events.js', () => ({
      makeAuditRunId: () => 'run-git',
      recordAuditEvent,
    }));
    vi.doMock('../src/security/runtime-secrets.js', async (importOriginal) => {
      const actual = await importOriginal<object>();
      return {
        ...actual,
        readStoredRuntimeSecret: (name: string) =>
          params.storedSecrets?.[name] ?? null,
      };
    });
    vi.doMock('../src/auth/github-connector-auth.js', async (importOriginal) => {
      const actual = await importOriginal<object>();
      return {
        ...actual,
        resolveGitHubConnectorAccessToken: async () =>
          params.connectorToken
            ? { accessToken: params.connectorToken, source: 'github-connector' }
            : null,
      };
    });
    return { recordAuditEvent, workspacePath };
  }

  test('issues the connector token for github.com and audits it', async () => {
    const { recordAuditEvent, workspacePath } = setup({
      connectorToken: 'ghs_connector',
      storedSecrets: { GH_TOKEN: 'ghp_stored' },
    });
    const { resolveGitHubGitCredential } = await import(
      '../src/gateway/gateway-git-credential.js'
    );

    await expect(
      resolveGitHubGitCredential({
        protocol: 'https',
        host: 'github.com',
        sessionId: 'agent:main:channel:web:chat:dm:peer:test',
      }),
    ).resolves.toEqual({
      username: 'x-access-token',
      password: 'ghs_connector',
      source: 'GITHUB_ACCESS_TOKEN',
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'secret.resolved',
          secretRef: { source: 'github-connector', id: 'GITHUB_ACCESS_TOKEN' },
          host: 'github.com',
        }),
      }),
    );
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('falls back to stored GH_TOKEN when the connector is not connected', async () => {
    const { workspacePath } = setup({
      connectorToken: null,
      storedSecrets: { GH_TOKEN: 'ghp_stored' },
    });
    const { resolveGitHubGitCredential } = await import(
      '../src/gateway/gateway-git-credential.js'
    );

    await expect(
      resolveGitHubGitCredential({ protocol: 'https', host: 'github.com' }),
    ).resolves.toMatchObject({ password: 'ghp_stored', source: 'GH_TOKEN' });
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('refuses non-GitHub hosts and plain http', async () => {
    const { workspacePath } = setup({ connectorToken: 'ghs_connector' });
    const { resolveGitHubGitCredential } = await import(
      '../src/gateway/gateway-git-credential.js'
    );

    await expect(
      resolveGitHubGitCredential({ protocol: 'https', host: 'gitlab.com' }),
    ).rejects.toThrow('not available for host gitlab.com');
    await expect(
      resolveGitHubGitCredential({ protocol: 'http', host: 'github.com' }),
    ).rejects.toThrow('only issued for https');
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  test('reports missing credentials with setup guidance', async () => {
    const { workspacePath } = setup({ connectorToken: null });
    const { resolveGitHubGitCredential } = await import(
      '../src/gateway/gateway-git-credential.js'
    );

    await expect(
      resolveGitHubGitCredential({ protocol: 'https', host: 'github.com' }),
    ).rejects.toThrow('No GitHub credentials available');
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
});

describe('container git credential helper', () => {
  test('answers github.com get requests from the gateway', async () => {
    const { runGitCredentialHelper } = await import(
      '../container/src/git-credential-helper.js'
    );
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { username: 'x-access-token', password: 'ghs_abc' }),
    );

    const result = await runGitCredentialHelper({
      operation: 'get',
      input: 'protocol=https\nhost=github.com\npath=org/repo.git\n\n',
      env: {
        HYBRIDCLAW_GATEWAY_URL: 'http://gateway.test/',
        HYBRIDCLAW_GATEWAY_TOKEN: 'gw-token',
        HYBRIDCLAW_SESSION_ID: 'session-1',
        HYBRIDCLAW_AGENT_ID: 'main',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({
      stdout: 'username=x-access-token\npassword=ghs_abc\n',
      stderr: '',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gateway.test/api/git/credential',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer gw-token' }),
        body: JSON.stringify({
          protocol: 'https',
          host: 'github.com',
          sessionId: 'session-1',
          agentId: 'main',
        }),
      }),
    );
  });

  test('ignores other hosts and store/erase operations', async () => {
    const { runGitCredentialHelper } = await import(
      '../container/src/git-credential-helper.js'
    );
    const fetchImpl = vi.fn();
    const env = { HYBRIDCLAW_GATEWAY_URL: 'http://gateway.test' };

    for (const call of [
      { operation: 'get', input: 'protocol=https\nhost=gitlab.com\n' },
      { operation: 'store', input: 'protocol=https\nhost=github.com\n' },
      { operation: 'erase', input: 'protocol=https\nhost=github.com\n' },
    ]) {
      await expect(
        runGitCredentialHelper({
          ...call,
          env,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).resolves.toEqual({ stdout: '', stderr: '' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports gateway errors on stderr without emitting credentials', async () => {
    const { runGitCredentialHelper } = await import(
      '../container/src/git-credential-helper.js'
    );
    const result = await runGitCredentialHelper({
      operation: 'get',
      input: 'protocol=https\nhost=github.com\n',
      env: { HYBRIDCLAW_GATEWAY_URL: 'http://gateway.test' },
      fetchImpl: (async () =>
        jsonResponse(404, {
          error: 'No GitHub credentials available.',
        })) as unknown as typeof fetch,
    });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('No GitHub credentials available.');
  });

  test('rejects credentials containing line breaks', async () => {
    const { runGitCredentialHelper } = await import(
      '../container/src/git-credential-helper.js'
    );
    const result = await runGitCredentialHelper({
      operation: 'get',
      input: 'protocol=https\nhost=github.com\n',
      env: { HYBRIDCLAW_GATEWAY_URL: 'http://gateway.test' },
      fetchImpl: (async () =>
        jsonResponse(200, {
          username: 'x-access-token',
          password: 'ghs\nhost=evil.example',
        })) as unknown as typeof fetch,
    });

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('invalid gateway response');
  });

  test('appends the helper after existing GIT_CONFIG entries', async () => {
    const { applyGitCredentialHelperEnv } = await import(
      '../container/src/git-credential-helper.js'
    );
    const env = applyGitCredentialHelperEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.editor',
        GIT_CONFIG_VALUE_0: 'true',
      },
      { helperPath: "/opt/it's/helper.js", nodePath: '/usr/bin/node' },
    );

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.editor',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: `!'/usr/bin/node' '/opt/it'\\''s/helper.js'`,
    });
  });
});
