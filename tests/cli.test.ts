import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-cli-'));
  tempDirs.push(dir);
  return dir;
}

async function importFreshCli(options?: {
  hybridAIStatus?: {
    authenticated: boolean;
    path: string;
    maskedApiKey: string | null;
    source: 'env' | 'runtime-secrets' | null;
  };
  hybridAILoginResult?: {
    path: string;
    apiKey: string;
    maskedApiKey: string;
    method: 'browser' | 'device-code' | 'env-import';
    validated: boolean;
  };
  gatewayReachable?: boolean;
  sandboxMode?: 'host' | 'container';
}) {
  vi.resetModules();

  const clearHybridAICredentials = vi.fn(() => '/tmp/credentials.json');
  const getHybridAIAuthStatus = vi.fn(
    () =>
      options?.hybridAIStatus || {
        authenticated: false,
        path: '/tmp/credentials.json',
        maskedApiKey: null,
        source: null,
      },
  );
  const loginHybridAIInteractive = vi.fn(
    async () =>
      options?.hybridAILoginResult || {
        path: '/tmp/credentials.json',
        apiKey: 'hai-default1234567890',
        maskedApiKey: 'hai-…7890',
        method: 'browser' as const,
        validated: true,
      },
  );
  const printUpdateUsage = vi.fn();
  const runUpdateCommand = vi.fn();
  const ensureRuntimeCredentials = vi.fn();
  const ensureContainerImageReady = vi.fn();
  const gatewayHealth = vi.fn(async () => {
    if (!options?.gatewayReachable) {
      throw new Error('gateway unavailable');
    }
    return {
      status: 'ok',
    };
  });
  const gatewayStatus = vi.fn(async () => ({
    status: 'ok',
    pid: 12345,
    version: '0.4.1',
    uptime: 1,
    sessions: 1,
    activeContainers: 0,
    defaultModel: 'gpt-5-nano',
    ragDefault: true,
    timestamp: new Date().toISOString(),
  }));
  const tuiModuleLoaded = vi.fn();

  class MissingRequiredEnvVarError extends Error {
    constructor(public readonly envVar: string) {
      super(`Missing required env var: ${envVar}`);
      this.name = 'MissingRequiredEnvVarError';
    }
  }

  class CodexAuthError extends Error {
    reloginRequired: boolean;

    constructor(
      message = 'codex error',
      options?: { reloginRequired?: boolean },
    ) {
      super(message);
      this.name = 'CodexAuthError';
      this.reloginRequired = options?.reloginRequired === true;
    }
  }

  vi.doMock('../src/auth/hybridai-auth.ts', () => ({
    clearHybridAICredentials,
    getHybridAIAuthStatus,
    loginHybridAIInteractive,
  }));
  vi.doMock('../src/auth/codex-auth.ts', () => ({
    CodexAuthError,
    clearCodexCredentials: vi.fn(),
    getCodexAuthStatus: vi.fn(() => ({
      authenticated: false,
      path: '/tmp/codex-auth.json',
      source: null,
      accountId: null,
      expiresAt: null,
      maskedAccessToken: null,
      reloginRequired: true,
    })),
    loginCodexInteractive: vi.fn(),
  }));
  vi.doMock('../src/config/cli-flags.ts', () => ({
    findUnsupportedGatewayLifecycleFlag: vi.fn(() => null),
    parseGatewayFlags: vi.fn(() => ({
      foreground: false,
      sandboxMode: null,
      passthrough: [],
    })),
  }));
  vi.doMock('../src/config/config.ts', () => ({
    APP_VERSION: '0.4.1',
    DATA_DIR: '/tmp/hybridclaw-data',
    GATEWAY_BASE_URL: 'http://127.0.0.1:9090',
    MissingRequiredEnvVarError,
    getResolvedSandboxMode: vi.fn(() => options?.sandboxMode || 'host'),
    setSandboxModeOverride: vi.fn(),
  }));
  vi.doMock('../src/gateway/gateway-client.ts', () => ({
    gatewayHealth,
    gatewayStatus,
  }));
  vi.doMock('../src/infra/container-setup.ts', () => ({
    ensureContainerImageReady,
  }));
  vi.doMock('../src/onboarding.ts', () => ({
    ensureRuntimeCredentials,
  }));
  vi.doMock('../src/security/instruction-approval-audit.ts', () => ({
    beginInstructionApprovalAudit: vi.fn(() => ({
      sessionId: 'tui:local',
      approvalId: 'approval-1',
    })),
    completeInstructionApprovalAudit: vi.fn(),
  }));
  vi.doMock('../src/security/instruction-integrity.ts', () => ({
    summarizeInstructionIntegrity: vi.fn(() => 'ok'),
    syncRuntimeInstructionCopies: vi.fn(),
    verifyInstructionIntegrity: vi.fn(() => ({ ok: true })),
  }));
  vi.doMock('../src/security/runtime-secrets.ts', () => ({
    runtimeSecretsPath: vi.fn(() => '/tmp/credentials.json'),
  }));
  vi.doMock('../src/tui.ts', () => {
    tuiModuleLoaded();
    return {};
  });
  vi.doMock('../src/update.ts', () => ({
    printUpdateUsage,
    runUpdateCommand,
  }));

  const cli = await import('../src/cli.ts');
  return {
    cli,
    clearHybridAICredentials,
    getHybridAIAuthStatus,
    loginHybridAIInteractive,
    printUpdateUsage,
    runUpdateCommand,
    ensureRuntimeCredentials,
    ensureContainerImageReady,
    gatewayHealth,
    gatewayStatus,
    tuiModuleLoaded,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/auth/hybridai-auth.ts');
  vi.doUnmock('../src/auth/codex-auth.ts');
  vi.doUnmock('../src/config/cli-flags.ts');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/gateway/gateway-client.ts');
  vi.doUnmock('../src/infra/container-setup.ts');
  vi.doUnmock('../src/onboarding.ts');
  vi.doUnmock('../src/security/instruction-approval-audit.ts');
  vi.doUnmock('../src/security/instruction-integrity.ts');
  vi.doUnmock('../src/security/runtime-secrets.ts');
  vi.doUnmock('../src/tui.ts');
  vi.doUnmock('../src/update.ts');
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI hybridai commands', () => {
  it('prints hybridai help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'hybridai']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw hybridai <command>'),
    );
  });

  it('prints hybridai usage for bare hybridai', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['hybridai']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('hybridclaw hybridai login --import'),
    );
  });

  it('prints authenticated hybridai status', async () => {
    const { cli, getHybridAIAuthStatus } = await importFreshCli({
      hybridAIStatus: {
        authenticated: true,
        path: '/tmp/credentials.json',
        maskedApiKey: 'hai-…1234',
        source: 'runtime-secrets',
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['hybridai', 'status']);

    expect(getHybridAIAuthStatus).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Authenticated: yes');
    expect(logSpy).toHaveBeenCalledWith('Source: runtime-secrets');
    expect(logSpy).toHaveBeenCalledWith('API key: hai-…1234');
  });

  it('prints unauthenticated hybridai status without source details', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['hybridai', 'status']);

    expect(logSpy).toHaveBeenCalledWith('Authenticated: no');
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Source:'));
  });

  it('runs hybridai login with explicit browser mode', async () => {
    const { cli, loginHybridAIInteractive } = await importFreshCli({
      hybridAILoginResult: {
        path: '/tmp/credentials.json',
        apiKey: 'hai-browser1234567890',
        maskedApiKey: 'hai-…7890',
        method: 'browser',
        validated: true,
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['hybridai', 'login', '--browser']);

    expect(loginHybridAIInteractive).toHaveBeenCalledWith({
      method: 'browser',
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Saved HybridAI credentials to /tmp/credentials.json.',
    );
    expect(logSpy).toHaveBeenCalledWith('Login method: browser');
    expect(logSpy).toHaveBeenCalledWith('Validated: yes');
  });

  it('runs hybridai login with auto mode by default', async () => {
    const { cli, loginHybridAIInteractive } = await importFreshCli();

    await cli.main(['hybridai', 'login']);

    expect(loginHybridAIInteractive).toHaveBeenCalledWith({
      method: 'auto',
    });
  });

  it('runs hybridai logout', async () => {
    const { cli, clearHybridAICredentials } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['hybridai', 'logout']);

    expect(clearHybridAICredentials).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Cleared HybridAI credentials in /tmp/credentials.json.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'If HYBRIDAI_API_KEY is still exported in your shell, unset it separately.',
    );
  });

  it('rejects conflicting hybridai login flags', async () => {
    const { cli } = await importFreshCli();

    await expect(
      cli.main(['hybridai', 'login', '--browser', '--import']),
    ).rejects.toThrow(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  });

  it('prints help and exits for an unknown help topic', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await cli.main(['help', 'unknown-topic']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw <command>'),
    );
    expect(errorSpy).toHaveBeenCalledWith('Unknown help topic: unknown-topic');
  });

  it('prints main usage and exits for an unknown command', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await cli.main(['unknown-command']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw <command>'),
    );
  });

  it('launches tui without local runtime preflight when gateway is already reachable', async () => {
    const {
      cli,
      ensureRuntimeCredentials,
      ensureContainerImageReady,
      gatewayHealth,
      tuiModuleLoaded,
    } = await importFreshCli({
      gatewayReachable: true,
      sandboxMode: 'container',
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['tui']);

    expect(gatewayHealth).toHaveBeenCalled();
    expect(ensureRuntimeCredentials).not.toHaveBeenCalled();
    expect(ensureContainerImageReady).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'hybridclaw tui: Gateway found at http://127.0.0.1:9090.',
    );
    expect(tuiModuleLoaded).toHaveBeenCalledTimes(1);
  });

  it('treats a symlinked bin path as direct execution', async () => {
    const { cli } = await importFreshCli();
    const tempDir = createTempDir();
    const linkPath = path.join(tempDir, 'hybridclaw');
    const cliPath = path.resolve('src/cli.ts');
    fs.symlinkSync(cliPath, linkPath);

    expect(
      cli.isDirectExecution(
        linkPath,
        pathToFileURL(cliPath).toString(),
      ),
    ).toBe(true);
  });
});
