import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const ORIGINAL_WHATSAPP_SETUP_SETTLE_MS =
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS;
const ORIGINAL_EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

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
  codexStatus?: {
    authenticated: boolean;
    path: string;
    source: 'device-code' | 'browser-pkce' | 'codex-cli-import' | null;
    accountId: string | null;
    expiresAt: number | null;
    maskedAccessToken: string | null;
    reloginRequired: boolean;
  };
  codexLoginResult?: {
    path: string;
    method: 'device-code' | 'browser-pkce' | 'codex-cli-import';
    credentials: {
      accountId: string;
      expiresAt: number;
    };
  };
  gatewayReachable?: boolean;
  sandboxMode?: 'host' | 'container';
  promptResponses?: string[];
}) {
  vi.resetModules();
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS = '0';
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: true,
  });
  const promptResponses = [...(options?.promptResponses || [])];

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
  const clearCodexCredentials = vi.fn(() => '/tmp/codex-auth.json');
  const getCodexAuthStatus = vi.fn(
    () =>
      options?.codexStatus || {
        authenticated: false,
        path: '/tmp/codex-auth.json',
        source: null,
        accountId: null,
        expiresAt: null,
        maskedAccessToken: null,
        reloginRequired: true,
      },
  );
  const loginCodexInteractive = vi.fn(
    async () =>
      options?.codexLoginResult || {
        path: '/tmp/codex-auth.json',
        method: 'browser-pkce' as const,
        credentials: {
          accountId: 'acct_default',
          expiresAt: Date.parse('2026-03-13T12:00:00.000Z'),
        },
      },
  );
  const printUpdateUsage = vi.fn();
  const runUpdateCommand = vi.fn();
  const ensureRuntimeCredentials = vi.fn();
  const ensureContainerImageReady = vi.fn();
  const saveRuntimeSecrets = vi.fn(() => '/tmp/credentials.json');
  const getWhatsAppAuthStatus = vi.fn(async () => ({
    linked: false,
    jid: null,
  }));
  const resetWhatsAppAuthState = vi.fn(async () => '/tmp/whatsapp-auth');
  const whatsappStart = vi.fn(async () => {});
  const whatsappStop = vi.fn(async () => {});
  const whatsappWaitForSocket = vi.fn(async () => ({
    user: { id: '12345@s.whatsapp.net' },
  }));
  const createWhatsAppConnectionManager = vi.fn(() => ({
    getSocket: vi.fn(() => null),
    start: whatsappStart,
    stop: whatsappStop,
    waitForSocket: whatsappWaitForSocket,
  }));
  const ensureRuntimeConfigFile = vi.fn(() => false);
  const getRuntimeConfig = vi.fn(() => ({
    discord: {
      prefix: '!claw',
      commandsOnly: false,
      commandMode: 'public',
      commandAllowedUserIds: [],
      commandUserId: '',
      groupPolicy: 'open',
      freeResponseChannels: [],
      guilds: {},
    },
    hybridai: { defaultModel: 'gpt-5-nano' },
    openrouter: {
      enabled: false,
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openrouter/anthropic/claude-sonnet-4'],
    },
    whatsapp: {
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4000,
      debounceMs: 2500,
      sendReadReceipts: true,
      ackReaction: '',
      mediaMaxMb: 20,
    },
    email: {
      enabled: false,
      imapHost: '',
      imapPort: 993,
      smtpHost: '',
      smtpPort: 587,
      address: '',
      pollIntervalMs: 15000,
      folders: ['INBOX'],
      allowFrom: [],
      textChunkLimit: 50000,
      mediaMaxMb: 20,
    },
    local: {
      backends: {
        ollama: { enabled: true, baseUrl: 'http://127.0.0.1:11434' },
        lmstudio: { enabled: false, baseUrl: 'http://127.0.0.1:1234/v1' },
        vllm: {
          enabled: false,
          baseUrl: 'http://127.0.0.1:8000/v1',
          apiKey: '',
        },
      },
    },
  }));
  const runtimeConfigPath = vi.fn(() => '/tmp/config.json');
  const updateRuntimeConfig = vi.fn(
    (mutator: (draft: Record<string, unknown>) => void) => {
      const draft = getRuntimeConfig();
      mutator(draft);
      return draft;
    },
  );
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
  const readlineQuestion = vi.fn(async () => promptResponses.shift() ?? '');
  const readlineClose = vi.fn();
  const readlineCreateInterface = vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  }));

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
    CODEX_DEFAULT_BASE_URL: 'https://chatgpt.com/backend-api/codex',
    CodexAuthError,
    clearCodexCredentials,
    getCodexAuthStatus,
    loginCodexInteractive,
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
  vi.doMock('../src/config/runtime-config.ts', () => ({
    ensureRuntimeConfigFile,
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/gateway/gateway-client.ts', () => ({
    gatewayHealth,
    gatewayStatus,
  }));
  vi.doMock('../src/infra/container-setup.ts', () => ({
    ensureContainerImageReady,
  }));
  vi.doMock('../src/channels/whatsapp/auth.ts', () => ({
    getWhatsAppAuthStatus,
    resetWhatsAppAuthState,
    WHATSAPP_AUTH_DIR: '/tmp/whatsapp-auth',
    WhatsAppAuthLockError: class WhatsAppAuthLockError extends Error {},
  }));
  vi.doMock('../src/channels/whatsapp/connection.ts', () => ({
    createWhatsAppConnectionManager,
  }));
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: readlineCreateInterface,
    },
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
    saveRuntimeSecrets,
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
    clearCodexCredentials,
    getCodexAuthStatus,
    getHybridAIAuthStatus,
    loginCodexInteractive,
    loginHybridAIInteractive,
    printUpdateUsage,
    runUpdateCommand,
    ensureRuntimeCredentials,
    ensureContainerImageReady,
    getWhatsAppAuthStatus,
    resetWhatsAppAuthState,
    createWhatsAppConnectionManager,
    whatsappStart,
    whatsappStop,
    whatsappWaitForSocket,
    saveRuntimeSecrets,
    ensureRuntimeConfigFile,
    getRuntimeConfig,
    runtimeConfigPath,
    updateRuntimeConfig,
    gatewayHealth,
    gatewayStatus,
    readlineCreateInterface,
    readlineQuestion,
    readlineClose,
    tuiModuleLoaded,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/auth/hybridai-auth.ts');
  vi.doUnmock('../src/auth/codex-auth.ts');
  vi.doUnmock('../src/config/cli-flags.ts');
  vi.doUnmock('../src/config/config.ts');
  vi.doUnmock('../src/config/runtime-config.ts');
  vi.doUnmock('../src/gateway/gateway-client.ts');
  vi.doUnmock('../src/infra/container-setup.ts');
  vi.doUnmock('../src/channels/whatsapp/auth.ts');
  vi.doUnmock('node:readline/promises');
  vi.doUnmock('../src/onboarding.ts');
  vi.doUnmock('../src/security/instruction-approval-audit.ts');
  vi.doUnmock('../src/security/instruction-integrity.ts');
  vi.doUnmock('../src/security/runtime-secrets.ts');
  vi.doUnmock('../src/tui.ts');
  vi.doUnmock('../src/update.ts');
  vi.resetModules();
  if (ORIGINAL_WHATSAPP_SETUP_SETTLE_MS === undefined) {
    delete process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS;
  } else {
    process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS =
      ORIGINAL_WHATSAPP_SETUP_SETTLE_MS;
  }
  if (ORIGINAL_OPENROUTER_API_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  }
  if (ORIGINAL_EMAIL_PASSWORD === undefined) {
    delete process.env.EMAIL_PASSWORD;
  } else {
    process.env.EMAIL_PASSWORD = ORIGINAL_EMAIL_PASSWORD;
  }
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: ORIGINAL_STDIN_IS_TTY,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: ORIGINAL_STDOUT_IS_TTY,
  });
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLI hybridai commands', () => {
  it('prints unified auth help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'auth']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Usage: hybridclaw auth <command> [provider] [options]',
      ),
    );
  });

  it('runs bare auth login through onboarding', async () => {
    const { cli, ensureRuntimeCredentials } = await importFreshCli();

    await cli.main(['auth', 'login']);

    expect(ensureRuntimeCredentials).toHaveBeenCalledWith({
      commandName: 'hybridclaw auth login',
    });
  });

  it('prints hybridai help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'hybridai']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Usage: hybridclaw hybridai <command> (deprecated)',
      ),
    );
  });

  it('marks local help as deprecated', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'local']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw local <command> (deprecated)'),
    );
  });

  it('prints channels help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'channels']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw channels <channel> <command>'),
    );
  });

  it('prints whatsapp help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'whatsapp']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('hybridclaw auth whatsapp reset'),
    );
  });

  it('runs discord channel setup and stores token when provided', async () => {
    const { cli, saveRuntimeSecrets, updateRuntimeConfig } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'channels',
      'discord',
      'setup',
      '--token',
      'discord-secret-token',
      '--allow-user-id',
      '123456789012345678',
    ]);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(saveRuntimeSecrets).toHaveBeenCalledWith({
      DISCORD_TOKEN: 'discord-secret-token',
    });
    expect(logSpy).toHaveBeenCalledWith('Discord mode: command-only');
  });

  it('treats empty inline discord setup values as omitted', async () => {
    const { cli, saveRuntimeSecrets, updateRuntimeConfig } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['channels', 'discord', 'setup', '--token=', '--prefix=']);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(saveRuntimeSecrets).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Discord token unchanged. Secrets path: /tmp/credentials.json',
    );
    expect(logSpy).toHaveBeenCalledWith('Discord prefix: !claw');
  });

  it('runs whatsapp channel setup and waits for pairing', async () => {
    const {
      cli,
      createWhatsAppConnectionManager,
      whatsappStart,
      whatsappStop,
      whatsappWaitForSocket,
    } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['channels', 'whatsapp', 'setup']);

    expect(createWhatsAppConnectionManager).toHaveBeenCalled();
    expect(whatsappStart).toHaveBeenCalled();
    expect(whatsappWaitForSocket).toHaveBeenCalled();
    expect(whatsappStop).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Opening WhatsApp pairing session...');
  });

  it('prompts for missing email setup fields and saves EMAIL_PASSWORD', async () => {
    const {
      cli,
      readlineCreateInterface,
      saveRuntimeSecrets,
      updateRuntimeConfig,
    } = await importFreshCli({
      promptResponses: [
        'agent@example.com',
        'imap.example.com',
        '993',
        'smtp.example.com',
        '587',
        'app-password-123',
        'boss@example.com, *@example.com',
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['channels', 'email', 'setup']);

    expect(readlineCreateInterface).toHaveBeenCalled();
    expect(saveRuntimeSecrets).toHaveBeenCalledWith({
      EMAIL_PASSWORD: 'app-password-123',
    });
    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      email: {
        address: string;
        allowFrom: string[];
        enabled: boolean;
        imapHost: string;
        smtpHost: string;
      };
    };
    expect(nextConfig.email.enabled).toBe(true);
    expect(nextConfig.email.address).toBe('agent@example.com');
    expect(nextConfig.email.imapHost).toBe('imap.example.com');
    expect(nextConfig.email.smtpHost).toBe('smtp.example.com');
    expect(nextConfig.email.allowFrom).toEqual([
      'boss@example.com',
      '*@example.com',
    ]);
    expect(logSpy).toHaveBeenCalledWith('Email mode: enabled');
  });

  it('runs auth whatsapp reset through the reset flow', async () => {
    const { cli, getWhatsAppAuthStatus, resetWhatsAppAuthState } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    getWhatsAppAuthStatus.mockResolvedValueOnce({
      linked: true,
      jid: '12345@s.whatsapp.net',
    });

    await cli.main(['auth', 'whatsapp', 'reset']);

    expect(getWhatsAppAuthStatus).toHaveBeenCalled();
    expect(resetWhatsAppAuthState).toHaveBeenCalledWith();
    expect(logSpy).toHaveBeenCalledWith(
      'Reset WhatsApp auth state at /tmp/whatsapp-auth.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Linked device state cleared. Re-run `hybridclaw channels whatsapp setup` to pair again.',
    );
  });

  it('prints hybridai usage for bare hybridai', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cli.main(['hybridai']);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('`hybridclaw hybridai ...` is deprecated'),
    );
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cli.main(['hybridai', 'status']);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Use `hybridclaw auth status hybridai` instead.'),
    );
    expect(getHybridAIAuthStatus).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Authenticated: yes');
    expect(logSpy).toHaveBeenCalledWith('Source: runtime-secrets');
    expect(logSpy).toHaveBeenCalledWith('API key: hai-…1234');
  });

  it('warns when using the deprecated local alias', async () => {
    const { cli } = await importFreshCli();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cli.main(['local', 'status']);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Use `hybridclaw auth status local` instead.'),
    );
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

  it('routes auth login hybridai to the HybridAI auth flow', async () => {
    const { cli, loginHybridAIInteractive } = await importFreshCli();

    await cli.main(['auth', 'login', 'hybridai', '--browser']);

    expect(loginHybridAIInteractive).toHaveBeenCalledWith({
      method: 'browser',
    });
  });

  it('routes auth login codex with import to the Codex auth flow', async () => {
    const { cli, loginCodexInteractive } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'login', 'codex', '--import']);

    expect(loginCodexInteractive).toHaveBeenCalledWith({
      method: 'codex-cli-import',
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Saved Codex credentials to /tmp/codex-auth.json.',
    );
  });

  it('routes auth login codex to the Codex auth flow', async () => {
    const { cli, loginCodexInteractive } = await importFreshCli();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cli.main(['auth', 'login', 'codex', '--browser']);

    expect(warnSpy).not.toHaveBeenCalled();
    expect(loginCodexInteractive).toHaveBeenCalledWith({
      method: 'browser-pkce',
    });
  });

  it('routes auth login local to local backend configuration', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'login', 'local', 'ollama', 'llama3.2']);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Backend: ollama');
    expect(logSpy).toHaveBeenCalledWith('Configured model: ollama/llama3.2');
  });

  it('configures OpenRouter from auth login with --api-key', async () => {
    const {
      cli,
      saveRuntimeSecrets,
      updateRuntimeConfig,
      readlineCreateInterface,
    } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'auth',
      'login',
      'openrouter',
      'anthropic/claude-sonnet-4',
      '--api-key',
      'or-secret-key',
    ]);

    expect(saveRuntimeSecrets).toHaveBeenCalledWith({
      OPENROUTER_API_KEY: 'or-secret-key',
    });
    expect(readlineCreateInterface).not.toHaveBeenCalled();
    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Provider: openrouter');
    expect(logSpy).toHaveBeenCalledWith(
      'Configured model: openrouter/anthropic/claude-sonnet-4',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Default model: openrouter/anthropic/claude-sonnet-4',
    );
  });

  it('prompts for the OpenRouter API key when flag and env are absent', async () => {
    const originalStdinTty = process.stdin.isTTY;
    const originalStdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    try {
      const {
        cli,
        saveRuntimeSecrets,
        readlineCreateInterface,
        readlineQuestion,
        readlineClose,
      } = await importFreshCli({
        promptResponses: ['or-pasted-key'],
      });

      await cli.main([
        'auth',
        'login',
        'openrouter',
        'anthropic/claude-sonnet-4',
      ]);

      expect(readlineCreateInterface).toHaveBeenCalled();
      expect(readlineQuestion).toHaveBeenCalledWith(
        'Paste OpenRouter API key: ',
      );
      expect(readlineClose).toHaveBeenCalled();
      expect(saveRuntimeSecrets).toHaveBeenCalledWith({
        OPENROUTER_API_KEY: 'or-pasted-key',
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalStdinTty,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: originalStdoutTty,
        configurable: true,
      });
    }
  });

  it('uses OPENROUTER_API_KEY without prompting when env is set', async () => {
    process.env.OPENROUTER_API_KEY = 'or-from-env';
    try {
      const { cli, saveRuntimeSecrets, readlineCreateInterface } =
        await importFreshCli();

      await cli.main([
        'auth',
        'login',
        'openrouter',
        'anthropic/claude-sonnet-4',
      ]);

      expect(readlineCreateInterface).not.toHaveBeenCalled();
      expect(saveRuntimeSecrets).toHaveBeenCalledWith({
        OPENROUTER_API_KEY: 'or-from-env',
      });
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('prints OpenRouter status through auth status', async () => {
    process.env.OPENROUTER_API_KEY = 'or-secret-key';
    try {
      const { cli } = await importFreshCli();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await cli.main(['auth', 'status', 'openrouter']);

      expect(logSpy).toHaveBeenCalledWith('Authenticated: yes');
      expect(logSpy).toHaveBeenCalledWith('Enabled: no');
      expect(logSpy).toHaveBeenCalledWith('Config: /tmp/config.json');
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it('clears OpenRouter credentials through auth logout', async () => {
    const { cli, saveRuntimeSecrets } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'logout', 'openrouter']);

    expect(saveRuntimeSecrets).toHaveBeenCalledWith({
      OPENROUTER_API_KEY: null,
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Cleared OpenRouter credentials in /tmp/credentials.json.',
    );
  });

  it('disables local backends through auth logout local', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'logout', 'local']);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Disabled local backends: ollama, lmstudio, vllm.',
    );
    expect(logSpy).toHaveBeenCalledWith('Default model: gpt-5-nano');
  });

  it('treats top-level login as an unknown command', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await cli.main(['login']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw <command>'),
    );
  });

  it('treats top-level status as an unknown command', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await cli.main(['status', 'openrouter']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw <command>'),
    );
  });

  it('treats top-level logout as an unknown command', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await cli.main(['logout', 'openrouter']);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw <command>'),
    );
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
      cli.isDirectExecution(linkPath, pathToFileURL(cliPath).toString()),
    ).toBe(true);
  });
});
