import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];
const ORIGINAL_WHATSAPP_SETUP_SETTLE_MS =
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS;
const ORIGINAL_EMAIL_PASSWORD = process.env.EMAIL_PASSWORD;
const ORIGINAL_MSTEAMS_APP_ID = process.env.MSTEAMS_APP_ID;
const ORIGINAL_MSTEAMS_APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD;
const ORIGINAL_MSTEAMS_TENANT_ID = process.env.MSTEAMS_TENANT_ID;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_HYBRIDCLAW_LOG_REQUESTS = process.env.HYBRIDCLAW_LOG_REQUESTS;
const ORIGINAL_CI = process.env.CI;
const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;
const REPO_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
  ) as { version: string }
).version;

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
  configModuleError?: Error | null;
  gatewayFlags?: {
    foreground?: boolean;
    sandboxMode?: 'host' | 'container' | null;
    debug?: boolean;
    help?: boolean;
    logRequests?: boolean;
    passthrough?: string[];
  };
  ensureContainerImageReadyError?: Error | null;
  gatewayModuleError?: Error | null;
  pluginInstallError?: Error | null;
  pluginInstallResult?: {
    pluginId: string;
    pluginDir: string;
    source: string;
    alreadyInstalled: boolean;
    dependenciesInstalled: boolean;
    requiresEnv: string[];
    requiredConfigKeys: string[];
  };
  pluginReinstallError?: Error | null;
  pluginReinstallResult?: {
    pluginId: string;
    pluginDir: string;
    source: string;
    alreadyInstalled: boolean;
    replacedExistingInstall: boolean;
    dependenciesInstalled: boolean;
    requiresEnv: string[];
    requiredConfigKeys: string[];
  };
  pluginUninstallError?: Error | null;
  pluginUninstallResult?: {
    pluginId: string;
    pluginDir: string;
    removedPluginDir: boolean;
    removedConfigOverrides: number;
  };
  pluginListSummary?: Array<{
    id: string;
    name?: string;
    version?: string;
    description?: string;
    source: 'home' | 'project' | 'config';
    enabled: boolean;
    error?: string;
    commands: string[];
    tools: string[];
    hooks: string[];
  }>;
  agentPackError?: Error | null;
  agentPackResult?: {
    archivePath: string;
    manifest: {
      name: string;
    };
    workspacePath: string;
    bundledSkills: string[];
    bundledPlugins: string[];
    externalSkills: Array<{ kind: string; ref: string }>;
    externalPlugins: Array<{ kind: string; ref: string }>;
    archiveEntries: string[];
  };
  agentInspectError?: Error | null;
  agentInspectResult?: {
    archivePath: string;
    manifest: {
      name: string;
      id?: string;
    };
    totalCompressedBytes: number;
    totalUncompressedBytes: number;
    entryNames: string[];
  };
  agentUnpackError?: Error | null;
  agentUnpackResult?: {
    archivePath: string;
    manifest: {
      name: string;
      id?: string;
    };
    agentId: string;
    workspacePath: string;
    bundledSkills: string[];
    installedPlugins: Array<{ pluginId: string }>;
    externalActions: string[];
    runtimeConfigChanged: boolean;
  };
  agentUninstallError?: Error | null;
  agentUninstallResult?: {
    agentId: string;
    agentRootPath: string;
    workspacePath: string;
    removedAgentRoot: boolean;
    removedRegistration: boolean;
  };
  agentListResult?: Array<{
    id: string;
    name: string;
    model?: string | { primary: string };
  }>;
  promptResponses?: string[];
  whatsAppConnectionModuleError?: Error | null;
}) {
  vi.resetModules();
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS = '0';
  delete process.env.CI;
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
  const runDoctorCli = vi.fn(async () => 0);
  const ensureRuntimeCredentials = vi.fn();
  const ensureContainerImageReady = vi.fn(async () => {
    if (options?.ensureContainerImageReadyError) {
      throw options.ensureContainerImageReadyError;
    }
  });
  const saveRuntimeSecrets = vi.fn(() => '/tmp/credentials.json');
  const loadSkillCatalog = vi.fn(() => [
    { name: 'pdf' },
    { name: 'docx' },
    { name: 'pptx' },
  ]);
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
  const installPlugin = vi.fn(async (source: string) => {
    if (options?.pluginInstallError) {
      throw options.pluginInstallError;
    }
    return (
      options?.pluginInstallResult || {
        pluginId: 'demo-plugin',
        pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
        source,
        alreadyInstalled: false,
        dependenciesInstalled: true,
        requiresEnv: [],
        requiredConfigKeys: [],
      }
    );
  });
  const reinstallPlugin = vi.fn(async (source: string) => {
    if (options?.pluginReinstallError) {
      throw options.pluginReinstallError;
    }
    return (
      options?.pluginReinstallResult || {
        pluginId: 'demo-plugin',
        pluginDir: '/tmp/.hybridclaw/plugins/demo-plugin',
        source,
        alreadyInstalled: false,
        replacedExistingInstall: true,
        dependenciesInstalled: true,
        requiresEnv: [],
        requiredConfigKeys: [],
      }
    );
  });
  const uninstallPlugin = vi.fn(async (pluginId: string) => {
    if (options?.pluginUninstallError) {
      throw options.pluginUninstallError;
    }
    return (
      options?.pluginUninstallResult || {
        pluginId,
        pluginDir: `/tmp/.hybridclaw/plugins/${pluginId}`,
        removedPluginDir: true,
        removedConfigOverrides: 0,
      }
    );
  });
  const readPluginConfigEntry = vi.fn((pluginId: string) => ({
    pluginId,
    configPath: '/tmp/config.json',
    entry: {
      id: pluginId,
      enabled: true,
      config: {
        searchMode: 'query',
      },
    },
  }));
  const readPluginConfigValue = vi.fn((pluginId: string, key: string) => ({
    pluginId,
    key,
    value: 'query',
    configPath: '/tmp/config.json',
    entry: {
      id: pluginId,
      enabled: true,
      config: {
        [key]: 'query',
      },
    },
  }));
  const unsetPluginConfigValue = vi.fn(
    async (pluginId: string, key: string) => ({
      pluginId,
      key,
      value: undefined,
      changed: true,
      removed: true,
      configPath: '/tmp/config.json',
      entry: null,
    }),
  );
  const writePluginConfigValue = vi.fn(
    async (pluginId: string, key: string, rawValue: string) => ({
      pluginId,
      key,
      value: rawValue,
      changed: true,
      removed: false,
      configPath: '/tmp/config.json',
      entry: {
        id: pluginId,
        enabled: true,
        config: {
          [key]: rawValue,
        },
      },
    }),
  );
  const listPluginSummary = vi.fn(() => options?.pluginListSummary || []);
  const ensurePluginManagerInitialized = vi.fn(async () => ({
    listPluginSummary,
  }));
  const initDatabase = vi.fn();
  const isDatabaseInitialized = vi.fn(() => false);
  const initAgentRegistry = vi.fn();
  const listAgents = vi.fn(
    () =>
      options?.agentListResult || [
        { id: 'main', name: 'Main Agent', model: 'gpt-5-mini' },
      ],
  );
  const packAgent = vi.fn(async () => {
    if (options?.agentPackError) throw options.agentPackError;
    return (
      options?.agentPackResult || {
        archivePath: '/tmp/main.claw',
        manifest: {
          name: 'Main Agent',
        },
        workspacePath: '/tmp/.hybridclaw/data/agents/main/workspace',
        bundledSkills: ['custom-skill'],
        bundledPlugins: ['demo-plugin'],
        externalSkills: [],
        externalPlugins: [],
        archiveEntries: ['manifest.json', 'workspace/SOUL.md'],
      }
    );
  });
  const inspectClawArchive = vi.fn(async () => {
    if (options?.agentInspectError) throw options.agentInspectError;
    return (
      options?.agentInspectResult || {
        archivePath: '/tmp/main.claw',
        manifest: {
          name: 'Main Agent',
          id: 'main',
        },
        totalCompressedBytes: 1024,
        totalUncompressedBytes: 2048,
        entryNames: ['manifest.json'],
      }
    );
  });
  const formatClawArchiveSummary = vi.fn(
    (inspection: { manifest: { name: string } }) => [
      `Name: ${inspection.manifest.name}`,
      'Bundled skills: 1',
    ],
  );
  const unpackAgent = vi.fn(async () => {
    if (options?.agentUnpackError) throw options.agentUnpackError;
    return (
      options?.agentUnpackResult || {
        archivePath: '/tmp/main.claw',
        manifest: {
          name: 'Main Agent',
          id: 'main',
        },
        agentId: 'imported-agent',
        workspacePath: '/tmp/.hybridclaw/data/agents/imported-agent/workspace',
        bundledSkills: ['custom-skill'],
        installedPlugins: [{ pluginId: 'demo-plugin' }],
        externalActions: [],
        runtimeConfigChanged: true,
      }
    );
  });
  const uninstallAgent = vi.fn((agentId: string) => {
    if (options?.agentUninstallError) throw options.agentUninstallError;
    return (
      options?.agentUninstallResult || {
        agentId,
        agentRootPath: `/tmp/.hybridclaw/data/agents/${agentId}`,
        workspacePath: `/tmp/.hybridclaw/data/agents/${agentId}/workspace`,
        removedAgentRoot: true,
        removedRegistration: true,
      }
    );
  });
  const ensureRuntimeConfigFile = vi.fn(() => false);
  const onRuntimeConfigChange = vi.fn(() => () => {});
  const actualRuntimeConfig = await import('../src/config/runtime-config.ts');
  let runtimeConfigState = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf8'),
  ) as ReturnType<typeof actualRuntimeConfig.getRuntimeConfig>;
  const getRuntimeConfig = vi.fn(() => structuredClone(runtimeConfigState));
  const runtimeConfigPath = vi.fn(() => '/tmp/config.json');
  const getRuntimeSkillScopeDisabledNames = vi.fn(
    (
      config: {
        skills?: {
          disabled?: string[];
          channelDisabled?: Record<string, string[]>;
        };
      },
      channelKind?: string,
    ) => {
      const rawDisabled = channelKind
        ? (config.skills?.channelDisabled?.[channelKind] ?? [])
        : (config.skills?.disabled ?? []);
      return new Set(
        rawDisabled.map((entry) => String(entry || '').trim()).filter(Boolean),
      );
    },
  );
  const setRuntimeSkillScopeEnabled = vi.fn(
    (
      draft: {
        skills: {
          disabled: string[];
          channelDisabled?: Record<string, string[]>;
        };
      },
      skillName: string,
      enabled: boolean,
      channelKind?: string,
    ) => {
      const rawDisabled = channelKind
        ? (draft.skills.channelDisabled?.[channelKind] ?? [])
        : draft.skills.disabled;
      const disabled = new Set(
        rawDisabled.map((entry) => String(entry || '').trim()).filter(Boolean),
      );
      if (enabled) {
        disabled.delete(skillName);
      } else {
        disabled.add(skillName);
      }
      const nextDisabled = [...disabled].sort((left, right) =>
        left.localeCompare(right),
      );
      if (channelKind) {
        draft.skills.channelDisabled = {
          ...(draft.skills.channelDisabled ?? {}),
          [channelKind]: nextDisabled,
        };
        return;
      }
      draft.skills.disabled = nextDisabled;
    },
  );
  const updateRuntimeConfig = vi.fn(
    (mutator: (draft: Record<string, unknown>) => void) => {
      const draft = getRuntimeConfig() as Record<string, unknown>;
      mutator(draft);
      runtimeConfigState = draft as typeof runtimeConfigState;
      return structuredClone(runtimeConfigState);
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
  const ensureGatewayRunDir = vi.fn();
  const findGatewayPidByPort = vi.fn(() => null);
  const readGatewayPid = vi.fn(() => null);
  const removeGatewayPidFile = vi.fn();
  const writeGatewayPid = vi.fn();
  const isPidRunning = vi.fn(() => true);
  const gatewayModuleLoaded = vi.fn();
  const tuiModuleLoaded = vi.fn();
  const runTui = vi.fn(async () => {
    tuiModuleLoaded();
  });
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
      foreground: options?.gatewayFlags?.foreground ?? false,
      sandboxMode: options?.gatewayFlags?.sandboxMode ?? null,
      debug: options?.gatewayFlags?.debug ?? false,
      help: options?.gatewayFlags?.help ?? false,
      logRequests: options?.gatewayFlags?.logRequests ?? false,
      passthrough: options?.gatewayFlags?.passthrough ?? [],
    })),
  }));
  vi.doMock('../src/config/config.ts', () => {
    if (options?.configModuleError) {
      throw options.configModuleError;
    }
    return {
      APP_VERSION: '0.4.1',
      DATA_DIR: '/tmp/hybridclaw-data',
      GATEWAY_BASE_URL: 'http://127.0.0.1:9090',
      MissingRequiredEnvVarError,
      getResolvedSandboxMode: vi.fn(() => options?.sandboxMode || 'host'),
      setSandboxModeOverride: vi.fn(),
    };
  });
  vi.doMock('../src/config/runtime-config.ts', async () => ({
    ...actualRuntimeConfig,
    ensureRuntimeConfigFile,
    getRuntimeSkillScopeDisabledNames,
    getRuntimeConfig,
    onRuntimeConfigChange,
    runtimeConfigPath,
    setRuntimeSkillScopeEnabled,
    updateRuntimeConfig,
  }));
  vi.doMock('../src/gateway/gateway-client.ts', () => ({
    gatewayHealth,
    gatewayStatus,
  }));
  vi.doMock('../src/gateway/gateway-lifecycle.ts', () => ({
    ensureGatewayRunDir,
    findGatewayPidByPort,
    GATEWAY_LOG_FILE_ENV: 'HYBRIDCLAW_GATEWAY_LOG_FILE',
    GATEWAY_LOG_REQUESTS_ENV: 'HYBRIDCLAW_LOG_REQUESTS',
    GATEWAY_LOG_PATH: '/tmp/hybridclaw-data/gateway/gateway.log',
    GATEWAY_STDIO_TO_LOG_ENV: 'HYBRIDCLAW_GATEWAY_STDIO_TO_LOG',
    isPidRunning,
    readGatewayPid,
    removeGatewayPidFile,
    writeGatewayPid,
  }));
  vi.doMock('../src/gateway/gateway.ts', () => {
    if (options?.gatewayModuleError) throw options.gatewayModuleError;
    gatewayModuleLoaded();
    return {};
  });
  vi.doMock('../src/infra/container-setup.ts', () => ({
    ensureContainerImageReady,
  }));
  vi.doMock('../src/channels/whatsapp/auth.ts', () => ({
    getWhatsAppAuthStatus,
    resetWhatsAppAuthState,
    WHATSAPP_AUTH_DIR: '/tmp/whatsapp-auth',
    WhatsAppAuthLockError: class WhatsAppAuthLockError extends Error {},
  }));
  vi.doMock('../src/channels/whatsapp/connection.ts', () => {
    if (options?.whatsAppConnectionModuleError) {
      throw options.whatsAppConnectionModuleError;
    }
    return {
      createWhatsAppConnectionManager,
    };
  });
  vi.doMock('node:readline/promises', () => ({
    default: {
      createInterface: readlineCreateInterface,
    },
  }));
  vi.doMock('../src/onboarding.ts', () => ({
    ensureRuntimeCredentials,
  }));
  vi.doMock('../src/skills/skills.ts', () => ({
    loadSkillCatalog,
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
    loadRuntimeSecrets: vi.fn(),
    runtimeSecretsPath: vi.fn(() => '/tmp/credentials.json'),
    saveRuntimeSecrets,
  }));
  vi.doMock('../src/tui.ts', () => {
    return {
      runTui,
    };
  });
  vi.doMock('../src/memory/db.js', () => ({
    initDatabase,
    isDatabaseInitialized,
  }));
  vi.doMock('../src/agents/agent-registry.js', () => ({
    initAgentRegistry,
    listAgents,
    getAgentById: vi.fn(
      (agentId: string) =>
        listAgents().find((agent) => agent.id === agentId) || null,
    ),
  }));
  vi.doMock('../src/agents/claw-archive.js', () => ({
    formatClawArchiveSummary,
    inspectClawArchive,
    packAgent,
    unpackAgent,
    uninstallAgent,
  }));
  vi.doMock('../src/plugins/plugin-install.ts', () => ({
    installPlugin,
    reinstallPlugin,
    uninstallPlugin,
  }));
  vi.doMock('../src/plugins/plugin-install.js', () => ({
    installPlugin,
    reinstallPlugin,
    uninstallPlugin,
  }));
  vi.doMock('../src/plugins/plugin-config.js', () => ({
    readPluginConfigEntry,
    readPluginConfigValue,
    unsetPluginConfigValue,
    writePluginConfigValue,
  }));
  vi.doMock('../src/plugins/plugin-manager.js', () => ({
    ensurePluginManagerInitialized,
    shutdownPluginManager: vi.fn(async () => {}),
  }));
  vi.doMock('../src/update.ts', () => ({
    printUpdateUsage,
    runUpdateCommand,
  }));
  vi.doMock('../src/doctor.ts', () => ({
    runDoctorCli,
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
    runDoctorCli,
    ensureRuntimeCredentials,
    ensureContainerImageReady,
    getWhatsAppAuthStatus,
    resetWhatsAppAuthState,
    createWhatsAppConnectionManager,
    installPlugin,
    reinstallPlugin,
    uninstallPlugin,
    readPluginConfigEntry,
    readPluginConfigValue,
    unsetPluginConfigValue,
    writePluginConfigValue,
    listPluginSummary,
    ensurePluginManagerInitialized,
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
    ensureGatewayRunDir,
    findGatewayPidByPort,
    readGatewayPid,
    removeGatewayPidFile,
    writeGatewayPid,
    isPidRunning,
    gatewayModuleLoaded,
    loadSkillCatalog,
    initDatabase,
    isDatabaseInitialized,
    initAgentRegistry,
    listAgents,
    packAgent,
    inspectClawArchive,
    formatClawArchiveSummary,
    unpackAgent,
    uninstallAgent,
    readlineCreateInterface,
    readlineQuestion,
    readlineClose,
    tuiModuleLoaded,
    runTui,
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
  vi.doUnmock('../src/gateway/gateway-lifecycle.ts');
  vi.doUnmock('../src/gateway/gateway.ts');
  vi.doUnmock('../src/infra/container-setup.ts');
  vi.doUnmock('../src/channels/whatsapp/auth.ts');
  vi.doUnmock('node:readline/promises');
  vi.doUnmock('../src/onboarding.ts');
  vi.doUnmock('../src/skills/skills.ts');
  vi.doUnmock('../src/security/instruction-approval-audit.ts');
  vi.doUnmock('../src/security/instruction-integrity.ts');
  vi.doUnmock('../src/security/runtime-secrets.ts');
  vi.doUnmock('../src/tui.ts');
  vi.doUnmock('../src/memory/db.js');
  vi.doUnmock('../src/agents/agent-registry.js');
  vi.doUnmock('../src/agents/claw-archive.js');
  vi.doUnmock('../src/plugins/plugin-install.ts');
  vi.doUnmock('../src/plugins/plugin-install.js');
  vi.doUnmock('../src/plugins/plugin-config.js');
  vi.doUnmock('../src/plugins/plugin-manager.js');
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
  if (ORIGINAL_HYBRIDCLAW_LOG_REQUESTS === undefined) {
    delete process.env.HYBRIDCLAW_LOG_REQUESTS;
  } else {
    process.env.HYBRIDCLAW_LOG_REQUESTS = ORIGINAL_HYBRIDCLAW_LOG_REQUESTS;
  }
  if (ORIGINAL_EMAIL_PASSWORD === undefined) {
    delete process.env.EMAIL_PASSWORD;
  } else {
    process.env.EMAIL_PASSWORD = ORIGINAL_EMAIL_PASSWORD;
  }
  if (ORIGINAL_MSTEAMS_APP_ID === undefined) {
    delete process.env.MSTEAMS_APP_ID;
  } else {
    process.env.MSTEAMS_APP_ID = ORIGINAL_MSTEAMS_APP_ID;
  }
  if (ORIGINAL_MSTEAMS_APP_PASSWORD === undefined) {
    delete process.env.MSTEAMS_APP_PASSWORD;
  } else {
    process.env.MSTEAMS_APP_PASSWORD = ORIGINAL_MSTEAMS_APP_PASSWORD;
  }
  if (ORIGINAL_MSTEAMS_TENANT_ID === undefined) {
    delete process.env.MSTEAMS_TENANT_ID;
  } else {
    process.env.MSTEAMS_TENANT_ID = ORIGINAL_MSTEAMS_TENANT_ID;
  }
  if (ORIGINAL_CI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ORIGINAL_CI;
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

  it('hides deprecated aliases from the top-level help output', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help']);

    const output = logSpy.mock.calls
      .map(([message]) => String(message))
      .join('\n');
    expect(output).not.toContain('Deprecated alias for local provider');
    expect(output).not.toContain('Deprecated alias for HybridAI provider');
    expect(output).not.toContain('Deprecated alias for Codex provider');
  });

  it('prints the CLI version without loading the runtime config module', async () => {
    const { cli } = await importFreshCli({
      configModuleError: new Error('config module should stay lazy'),
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['--version']);

    expect(logSpy).toHaveBeenCalledWith(REPO_VERSION);
  });

  it('runs bare auth login through onboarding', async () => {
    const { cli, ensureRuntimeCredentials } = await importFreshCli();

    await cli.main(['auth', 'login']);

    expect(ensureRuntimeCredentials).toHaveBeenCalledWith({
      commandName: 'hybridclaw auth login',
    });
  });

  it('resets WhatsApp auth without loading the connection manager', async () => {
    const { cli, getWhatsAppAuthStatus, resetWhatsAppAuthState } =
      await importFreshCli({
        whatsAppConnectionModuleError: new Error(
          'whatsapp connection module should stay lazy',
        ),
      });

    await cli.main(['auth', 'whatsapp', 'reset']);

    expect(getWhatsAppAuthStatus).toHaveBeenCalled();
    expect(resetWhatsAppAuthState).toHaveBeenCalled();
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

  it('prints plugin help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'plugin']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('hybridclaw plugin list'),
    );
  });

  it('lists discovered plugins with descriptions, commands, tools, hooks, and errors', async () => {
    const { cli, ensurePluginManagerInitialized, listPluginSummary } =
      await importFreshCli({
        pluginListSummary: [
          {
            id: 'demo-plugin',
            name: 'Demo Plugin',
            version: '1.0.0',
            description: 'Demo plugin for testing',
            source: 'project',
            enabled: true,
            commands: ['demo_status'],
            tools: ['demo_echo'],
            hooks: ['demo-hook'],
          },
          {
            id: 'broken-plugin',
            source: 'home',
            enabled: true,
            error: 'register exploded',
            commands: [],
            tools: [],
            hooks: [],
          },
        ],
      });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'list']);

    expect(ensurePluginManagerInitialized).toHaveBeenCalled();
    expect(listPluginSummary).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      [
        'demo-plugin v1.0.0 [project]',
        '  name: Demo Plugin',
        '  description: Demo plugin for testing',
        '  enabled: yes',
        '  commands: /demo_status',
        '  tools: demo_echo',
        '  hooks: demo-hook',
        '',
        'broken-plugin [home]',
        '  enabled: yes',
        '  error: register exploded',
        '  commands: (none)',
        '  tools: (none)',
        '  hooks: (none)',
      ].join('\n'),
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

  it('prints msteams help', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'msteams']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('hybridclaw auth login msteams'),
    );
  });

  it('shows a plugin config override', async () => {
    const { cli, readPluginConfigEntry } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'config', 'qmd-memory']);

    expect(readPluginConfigEntry).toHaveBeenCalledWith('qmd-memory');
    expect(logSpy).toHaveBeenCalledWith('Plugin: qmd-memory');
    expect(logSpy).toHaveBeenCalledWith('Config file: /tmp/config.json');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"searchMode": "query"'),
    );
  });

  it('sets a plugin config override', async () => {
    const { cli, writePluginConfigValue } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'config', 'qmd-memory', 'searchMode', 'query']);

    expect(writePluginConfigValue).toHaveBeenCalledWith(
      'qmd-memory',
      'searchMode',
      'query',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Set plugin config qmd-memory.searchMode = "query".',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Updated runtime config at /tmp/config.json.',
    );
  });

  it('installs a plugin and leaves runtime config for optional overrides', async () => {
    const { cli, installPlugin } = await importFreshCli({
      pluginInstallResult: {
        pluginId: 'example-plugin',
        pluginDir: '/tmp/.hybridclaw/plugins/example-plugin',
        source: '@scope/hybridclaw-plugin-example',
        alreadyInstalled: false,
        dependenciesInstalled: true,
        requiresEnv: ['EXAMPLE_PLUGIN_TOKEN'],
        requiredConfigKeys: ['workspaceId'],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'install', '@scope/hybridclaw-plugin-example']);

    expect(installPlugin).toHaveBeenCalledWith(
      '@scope/hybridclaw-plugin-example',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Installed plugin example-plugin to /tmp/.hybridclaw/plugins/example-plugin.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Plugin example-plugin will auto-discover from /tmp/.hybridclaw/plugins/example-plugin.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Required env vars: EXAMPLE_PLUGIN_TOKEN',
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Add a plugins.list[] override in '),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('to set required config keys: workspaceId'),
    );
  });

  it('reinstalls a plugin and preserves the usual install guidance', async () => {
    const { cli, reinstallPlugin } = await importFreshCli({
      pluginReinstallResult: {
        pluginId: 'example-plugin',
        pluginDir: '/tmp/.hybridclaw/plugins/example-plugin',
        source: './plugins/example-plugin',
        alreadyInstalled: false,
        replacedExistingInstall: true,
        dependenciesInstalled: true,
        requiresEnv: ['EXAMPLE_PLUGIN_TOKEN'],
        requiredConfigKeys: ['workspaceId'],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'reinstall', './plugins/example-plugin']);

    expect(reinstallPlugin).toHaveBeenCalledWith('./plugins/example-plugin');
    expect(logSpy).toHaveBeenCalledWith(
      'Reinstalled plugin example-plugin to /tmp/.hybridclaw/plugins/example-plugin.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Plugin example-plugin will auto-discover from /tmp/.hybridclaw/plugins/example-plugin.',
    );
  });

  it('uninstalls a plugin and reports removed runtime config overrides', async () => {
    const { cli, uninstallPlugin } = await importFreshCli({
      pluginUninstallResult: {
        pluginId: 'example-plugin',
        pluginDir: '/tmp/.hybridclaw/plugins/example-plugin',
        removedPluginDir: true,
        removedConfigOverrides: 2,
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['plugin', 'uninstall', 'example-plugin']);

    expect(uninstallPlugin).toHaveBeenCalledWith('example-plugin');
    expect(logSpy).toHaveBeenCalledWith(
      'Uninstalled plugin example-plugin from /tmp/.hybridclaw/plugins/example-plugin.',
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Removed 2 plugins.list[] overrides from '),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Restart the gateway to unload plugin changes if it is running:',
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
        '',
        'smtp.example.com',
        '587',
        '',
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
        imapSecure: boolean;
        smtpHost: string;
        smtpSecure: boolean;
      };
    };
    expect(nextConfig.email.enabled).toBe(true);
    expect(nextConfig.email.address).toBe('agent@example.com');
    expect(nextConfig.email.imapHost).toBe('imap.example.com');
    expect(nextConfig.email.imapSecure).toBe(true);
    expect(nextConfig.email.smtpHost).toBe('smtp.example.com');
    expect(nextConfig.email.smtpSecure).toBe(false);
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
      expect.stringContaining(
        'hybridclaw auth login hybridai [--device-code|--browser|--import] [--base-url <url>]',
      ),
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
    expect(logSpy).toHaveBeenCalledWith('Config: /tmp/config.json');
    expect(logSpy).toHaveBeenCalledWith('Base URL: https://hybridai.one');
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

  it('updates the HybridAI base URL from the deprecated hybridai command', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await cli.main(['hybridai', 'base-url', 'http://localhost:5000']);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      hybridai: {
        baseUrl: string;
      };
    };
    expect(nextConfig.hybridai.baseUrl).toBe('http://localhost:5000');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Use `hybridclaw auth login hybridai --base-url <url>` instead.',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith('Provider: hybridai');
    expect(logSpy).toHaveBeenCalledWith('Base URL: http://localhost:5000');
    expect(logSpy).toHaveBeenCalledWith('  hybridclaw hybridai status');
  });

  it('rejects invalid HybridAI base URLs from the deprecated hybridai command', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();

    await expect(
      cli.main(['hybridai', 'base-url', 'javascript://alert(1)']),
    ).rejects.toThrow(
      'Invalid HybridAI base URL. Expected an absolute http:// or https:// URL.',
    );

    expect(updateRuntimeConfig).not.toHaveBeenCalled();
  });

  it('routes auth login hybridai --base-url through the HybridAI auth flow and updates config', async () => {
    const { cli, loginHybridAIInteractive, updateRuntimeConfig } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'auth',
      'login',
      'hybridai',
      '--base-url',
      'http://localhost:5000',
      '--browser',
    ]);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      hybridai: {
        baseUrl: string;
      };
    };
    expect(nextConfig.hybridai.baseUrl).toBe('http://localhost:5000');
    expect(loginHybridAIInteractive).toHaveBeenCalledWith({
      method: 'browser',
      baseUrl: 'http://localhost:5000',
    });
    expect(logSpy).toHaveBeenCalledWith('Base URL: http://localhost:5000');
  });

  it('rejects invalid HybridAI login --base-url values before persisting config', async () => {
    const { cli, loginHybridAIInteractive, updateRuntimeConfig } =
      await importFreshCli();

    await expect(
      cli.main([
        'auth',
        'login',
        'hybridai',
        '--base-url',
        '/relative',
        '--browser',
      ]),
    ).rejects.toThrow(
      'Invalid HybridAI base URL. Expected an absolute http:// or https:// URL.',
    );

    expect(updateRuntimeConfig).not.toHaveBeenCalled();
    expect(loginHybridAIInteractive).not.toHaveBeenCalled();
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

  it('rejects conflicting codex login flags', async () => {
    const { cli } = await importFreshCli();

    await expect(
      cli.main(['auth', 'login', 'codex', '--browser', '--import']),
    ).rejects.toThrow(
      'Use only one of `--device-code`, `--browser`, or `--import`.',
    );
  });

  it('routes auth login local to local backend configuration', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'login', 'local', 'ollama', 'llama3.2']);

    expect(updateRuntimeConfig).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Backend: ollama');
    expect(logSpy).toHaveBeenCalledWith('Configured model: ollama/llama3.2');
  });

  it('routes auth login msteams to the Teams auth flow', async () => {
    const { cli, saveRuntimeSecrets, updateRuntimeConfig } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'auth',
      'login',
      'msteams',
      '--app-id',
      'teams-app-id',
      '--tenant-id',
      'teams-tenant-id',
      '--app-password',
      'teams-secret',
    ]);

    expect(saveRuntimeSecrets).toHaveBeenCalledWith({
      MSTEAMS_APP_PASSWORD: 'teams-secret',
    });
    expect(updateRuntimeConfig).toHaveBeenCalled();
    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      msteams: {
        appId: string;
        enabled: boolean;
        tenantId: string;
      };
    };
    expect(nextConfig.msteams.enabled).toBe(true);
    expect(nextConfig.msteams.appId).toBe('teams-app-id');
    expect(nextConfig.msteams.tenantId).toBe('teams-tenant-id');
    expect(logSpy).toHaveBeenCalledWith('Microsoft Teams mode: enabled');
  });

  it('prompts for the optional Teams tenant id during interactive login', async () => {
    const {
      cli,
      readlineCreateInterface,
      readlineQuestion,
      updateRuntimeConfig,
    } = await importFreshCli({
      promptResponses: ['teams-app-id', 'teams-secret', 'teams-tenant-id'],
    });

    await cli.main(['auth', 'login', 'msteams']);

    expect(readlineCreateInterface).toHaveBeenCalled();
    expect(readlineQuestion).toHaveBeenCalledWith('Microsoft Teams app id: ');
    expect(readlineQuestion).toHaveBeenCalledWith(
      'Microsoft Teams app password: ',
    );
    expect(readlineQuestion).toHaveBeenCalledWith(
      'Microsoft Teams tenant id (optional): ',
    );
    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      msteams: {
        appId: string;
        tenantId: string;
      };
    };
    expect(nextConfig.msteams.appId).toBe('teams-app-id');
    expect(nextConfig.msteams.tenantId).toBe('teams-tenant-id');
  });

  it('prints Microsoft Teams status through auth status', async () => {
    process.env.MSTEAMS_APP_ID = 'teams-app-id';
    process.env.MSTEAMS_APP_PASSWORD = 'teams-secret';
    process.env.MSTEAMS_TENANT_ID = 'teams-tenant-id';
    const { cli, getRuntimeConfig } = await importFreshCli();
    getRuntimeConfig.mockReturnValue({
      ...getRuntimeConfig(),
      msteams: {
        enabled: true,
        appId: '',
        tenantId: '',
        webhook: {
          port: 3978,
          path: '/api/msteams/messages',
        },
        groupPolicy: 'open',
        dmPolicy: 'open',
        allowFrom: [],
        teams: {},
        requireMention: true,
        textChunkLimit: 4000,
        replyStyle: 'thread',
        mediaMaxMb: 20,
        dangerouslyAllowNameMatching: false,
        mediaAllowHosts: [],
        mediaAuthAllowHosts: [],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['auth', 'status', 'msteams']);

    expect(logSpy).toHaveBeenCalledWith('Authenticated: yes');
    expect(logSpy).toHaveBeenCalledWith('Enabled: yes');
    expect(logSpy).toHaveBeenCalledWith('App ID: teams-app-id');
    expect(logSpy).toHaveBeenCalledWith('Tenant ID: teams-tenant-id');
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
    expect(logSpy).toHaveBeenCalledWith('Default model: hybridai/gpt-5-nano');
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

  it('rejects unknown hybridai login flags', async () => {
    const { cli } = await importFreshCli();

    await expect(
      cli.main(['hybridai', 'login', '--base-ur', 'http://localhost:5000']),
    ).rejects.toThrow('Unknown flag: --base-ur');
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

  it('delegates doctor commands to the doctor module and forwards the exit code', async () => {
    const { cli, runDoctorCli } = await importFreshCli();
    runDoctorCli.mockResolvedValueOnce(1);
    process.exitCode = 0;

    await cli.main(['doctor', '--fix', 'docker']);

    expect(runDoctorCli).toHaveBeenCalledWith(['--fix', 'docker']);
    expect(process.exitCode).toBe(1);
  });

  it('writes and cleans up a managed PID file for gateway start --foreground', async () => {
    const {
      cli,
      ensureGatewayRunDir,
      ensureRuntimeCredentials,
      gatewayModuleLoaded,
      removeGatewayPidFile,
      writeGatewayPid,
    } = await importFreshCli({
      gatewayFlags: {
        foreground: true,
        sandboxMode: 'host',
      },
    });
    const registered = new Map<string, Array<(...args: unknown[]) => void>>();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      const key = String(event);
      const listeners = registered.get(key) ?? [];
      listeners.push(listener);
      registered.set(key, listeners);
      return process;
    }) as never);

    await cli.main(['gateway', 'start', '--foreground', '--sandbox=host']);

    expect(ensureRuntimeCredentials).toHaveBeenCalledWith({
      commandName: 'hybridclaw gateway start --foreground',
    });
    expect(ensureGatewayRunDir).toHaveBeenCalled();
    expect(writeGatewayPid).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: process.pid,
        cwd: process.cwd(),
      }),
    );
    expect(gatewayModuleLoaded).toHaveBeenCalled();
    expect(registered.get('exit')).toHaveLength(1);
    expect(registered.get('SIGINT')).toHaveLength(1);
    expect(registered.get('SIGTERM')).toHaveLength(1);

    removeGatewayPidFile.mockClear();
    registered.get('exit')?.[0]();

    expect(removeGatewayPidFile).toHaveBeenCalledTimes(1);
  });

  it('enables redacted request logging for gateway start --foreground', async () => {
    const { cli } = await importFreshCli({
      gatewayFlags: {
        foreground: true,
        logRequests: true,
      },
    });
    const registered = new Map<string, Array<(...args: unknown[]) => void>>();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      const key = String(event);
      const listeners = registered.get(key) ?? [];
      listeners.push(listener);
      registered.set(key, listeners);
      return process;
    }) as never);

    await cli.main(['gateway', 'start', '--foreground', '--log-requests']);

    expect(process.env.HYBRIDCLAW_LOG_REQUESTS).toBe('1');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'request_log stores best-effort redacted prompts',
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Treat this log as potentially sensitive.'),
    );
  });

  it('cleans up the managed PID file if gateway foreground startup fails', async () => {
    const startupError = new Error('gateway bootstrap failed');
    const { cli, removeGatewayPidFile, writeGatewayPid } = await importFreshCli(
      {
        gatewayFlags: {
          foreground: true,
          sandboxMode: 'container',
        },
        ensureContainerImageReadyError: startupError,
      },
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(
      ((_: string | symbol, __: (...args: unknown[]) => void) =>
        process) as never,
    );

    await expect(
      cli.main(['gateway', 'start', '--foreground', '--sandbox=container']),
    ).rejects.toThrow('gateway bootstrap failed');

    expect(writeGatewayPid).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: process.pid,
      }),
    );
    expect(removeGatewayPidFile).toHaveBeenCalledTimes(1);
  });

  it('launches tui without local runtime preflight when gateway is already reachable', async () => {
    const {
      cli,
      ensureRuntimeCredentials,
      ensureContainerImageReady,
      gatewayHealth,
      runTui,
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
    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(
          /^agent:main:channel:tui:chat:dm:peer:\d{8}_\d{6}_[0-9a-f]{6}$/,
        ),
        sessionMode: 'new',
        startedAtMs: expect.any(Number),
        resumeCommand: 'hybridclaw tui --resume',
      }),
    );
    expect(tuiModuleLoaded).toHaveBeenCalledTimes(1);
  });

  it('passes an explicit session id through tui --resume', async () => {
    const { cli, runTui } = await importFreshCli({
      gatewayReachable: true,
    });

    await cli.main(['tui', '--resume', '20260316_122238_532f05']);

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '20260316_122238_532f05',
        sessionMode: 'resume',
        resumeCommand: 'hybridclaw tui --resume',
      }),
    );
  });

  it('supports top-level --resume as a shortcut to tui', async () => {
    const { cli, runTui } = await importFreshCli({
      gatewayReachable: true,
    });

    await cli.main(['--resume', '20260316_122238_532f05']);

    expect(runTui).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: '20260316_122238_532f05',
        sessionMode: 'resume',
        resumeCommand: 'hybridclaw tui --resume',
      }),
    );
  });

  it('disables a skill for one channel scope', async () => {
    const { cli, updateRuntimeConfig } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['skill', 'disable', 'pdf', '--channel', 'teams']);

    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      skills: {
        disabled: string[];
        channelDisabled?: Record<string, string[]>;
      };
    };
    expect(nextConfig.skills.disabled).toEqual([]);
    expect(nextConfig.skills.channelDisabled).toMatchObject({
      msteams: ['pdf'],
    });
    expect(logSpy).toHaveBeenCalledWith('Disabled pdf in msteams scope.');
  });

  it('enables a globally disabled skill without changing channel overrides', async () => {
    const { cli, getRuntimeConfig, updateRuntimeConfig } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    getRuntimeConfig.mockReturnValue({
      ...getRuntimeConfig(),
      skills: {
        extraDirs: [],
        disabled: ['pdf'],
        channelDisabled: {
          discord: ['docx'],
        },
      },
    });

    await cli.main(['skill', 'enable', 'pdf']);

    const nextConfig = updateRuntimeConfig.mock.results[0]?.value as {
      skills: {
        disabled: string[];
        channelDisabled?: Record<string, string[]>;
      };
    };
    expect(nextConfig.skills.disabled).toEqual([]);
    expect(nextConfig.skills.channelDisabled).toMatchObject({
      discord: ['docx'],
    });
    expect(logSpy).toHaveBeenCalledWith('Enabled pdf in global scope.');
  });

  it('prints agent help from the help topic', async () => {
    const { cli } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['help', 'agent']);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: hybridclaw agent <command>'),
    );
  });

  it('runs agent list and prints tab-separated rows', async () => {
    const { cli, listAgents } = await importFreshCli({
      agentListResult: [
        { id: 'main', name: 'Main Agent', model: 'gpt-5-mini' },
        { id: 'writer', name: 'Writer Agent', model: { primary: 'gpt-5' } },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['agent', 'list']);

    expect(listAgents).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('main\tMain Agent\tgpt-5-mini');
    expect(logSpy).toHaveBeenCalledWith('writer\tWriter Agent\tgpt-5');
  });

  it('runs agent inspect and prints the archive summary', async () => {
    const { cli, inspectClawArchive, formatClawArchiveSummary } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['agent', 'inspect', '/tmp/demo.claw']);

    expect(inspectClawArchive).toHaveBeenCalledWith(
      path.resolve('/tmp/demo.claw'),
    );
    expect(formatClawArchiveSummary).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Name: Main Agent'),
    );
  });

  it('runs agent export and reports bundled content counts', async () => {
    const { cli, packAgent, initDatabase, initAgentRegistry } =
      await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['agent', 'export', 'main', '-o', '/tmp/export.claw']);

    expect(initDatabase).toHaveBeenCalledWith({ quiet: true });
    expect(initAgentRegistry).toHaveBeenCalled();
    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        outputPath: path.resolve('/tmp/export.claw'),
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Exported agent Main Agent to /tmp/main.claw.'),
    );
    expect(logSpy).toHaveBeenCalledWith('🧩 Bundled skills: 1');
    expect(logSpy).toHaveBeenCalledWith('🔌 Bundled plugins: 1');
  });

  it('passes export metadata and dry-run flags through to packAgent', async () => {
    const { cli, packAgent } = await importFreshCli({
      agentPackResult: {
        archivePath: '/tmp/preview.claw',
        manifest: {
          name: 'Main Agent',
        },
        workspacePath: '/tmp/.hybridclaw/data/agents/main/workspace',
        bundledSkills: [],
        bundledPlugins: [],
        externalSkills: [],
        externalPlugins: [],
        archiveEntries: ['manifest.json', 'workspace/SOUL.md'],
      },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'agent',
      'export',
      'main',
      '--description',
      'Portable starter',
      '--author',
      'Tester',
      '--version',
      '1.2.3',
      '--dry-run',
    ]);

    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        dryRun: true,
        manifestMetadata: {
          description: 'Portable starter',
          author: 'Tester',
          version: '1.2.3',
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Dry run export for agent Main Agent: /tmp/preview.claw.',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith('📄 Archive entries:');
    expect(logSpy).toHaveBeenCalledWith('  manifest.json');
  });

  it('passes --skills active through to packAgent during export', async () => {
    const { cli, packAgent } = await importFreshCli();

    await cli.main(['agent', 'export', 'main', '--skills', 'active']);

    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        skillSelection: {
          mode: 'active',
        },
      }),
    );
  });

  it('passes explicit skill selections through to packAgent during export', async () => {
    const { cli, packAgent } = await importFreshCli();

    await cli.main([
      'agent',
      'export',
      'main',
      '--skills',
      'some',
      '--skill',
      '1password',
      '--skill',
      'apple-calendar',
    ]);

    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        skillSelection: {
          mode: 'some',
          names: ['1password', 'apple-calendar'],
        },
      }),
    );
  });

  it('rejects --skill without --skills some', async () => {
    const { cli, packAgent } = await importFreshCli();

    await expect(
      cli.main(['agent', 'export', 'main', '--skill', '1password']),
    ).rejects.toThrow('`--skill <name>` requires `--skills some`.');
    expect(packAgent).not.toHaveBeenCalled();
  });

  it('passes --plugins active through to packAgent during export', async () => {
    const { cli, packAgent } = await importFreshCli();

    await cli.main(['agent', 'export', 'main', '--plugins', 'active']);

    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        pluginSelection: {
          mode: 'active',
        },
      }),
    );
  });

  it('passes explicit plugin selections through to packAgent during export', async () => {
    const { cli, packAgent } = await importFreshCli();

    await cli.main([
      'agent',
      'export',
      'main',
      '--plugins',
      'some',
      '--plugin',
      'demo-plugin',
      '--plugin',
      'qmd-memory',
    ]);

    expect(packAgent).toHaveBeenCalledWith(
      'main',
      expect.objectContaining({
        pluginSelection: {
          mode: 'some',
          names: ['demo-plugin', 'qmd-memory'],
        },
      }),
    );
  });

  it('rejects --plugin without --plugins some', async () => {
    const { cli, packAgent } = await importFreshCli();

    await expect(
      cli.main(['agent', 'export', 'main', '--plugin', 'demo-plugin']),
    ).rejects.toThrow('`--plugin <id>` requires `--plugins some`.');
    expect(packAgent).not.toHaveBeenCalled();
  });

  it('reuses one readline interface across export prompts', async () => {
    const { cli, packAgent, readlineCreateInterface, readlineClose } =
      await importFreshCli({
        promptResponses: [
          'e',
          'https://github.com/example/custom-skill.git',
          'custom-skill',
          'e',
          'npm',
          '@example/demo-plugin',
          'demo-plugin',
        ],
      });

    packAgent.mockImplementationOnce(async (_agentId, options) => {
      await options.promptSelection?.({
        kind: 'skill',
        directoryName: 'custom-skill',
        sourceDir: '/tmp/skill',
      });
      await options.promptSelection?.({
        kind: 'plugin',
        pluginId: 'demo-plugin',
        sourceDir: '/tmp/plugin',
        packageName: '@example/demo-plugin',
      });
      return {
        archivePath: '/tmp/main.claw',
        manifest: {
          name: 'Main Agent',
        },
        workspacePath: '/tmp/.hybridclaw/data/agents/main/workspace',
        bundledSkills: [],
        bundledPlugins: [],
        externalSkills: [],
        externalPlugins: [],
        archiveEntries: ['manifest.json'],
      };
    });

    await cli.main(['agent', 'export', 'main']);

    expect(readlineCreateInterface).toHaveBeenCalledTimes(1);
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });

  it('treats n as skip during interactive export prompts', async () => {
    const { cli, packAgent, readlineQuestion } = await importFreshCli({
      promptResponses: ['n', 'n'],
    });

    const selections: unknown[] = [];
    packAgent.mockImplementationOnce(async (_agentId, options) => {
      selections.push(
        await options.promptSelection?.({
          kind: 'skill',
          directoryName: 'custom-skill',
          sourceDir: '/tmp/skill',
        }),
      );
      selections.push(
        await options.promptSelection?.({
          kind: 'plugin',
          pluginId: 'demo-plugin',
          sourceDir: '/tmp/plugin',
          packageName: '@example/demo-plugin',
        }),
      );
      return {
        archivePath: '/tmp/main.claw',
        manifest: {
          name: 'Main Agent',
        },
        workspacePath: '/tmp/.hybridclaw/data/agents/main/workspace',
        bundledSkills: [],
        bundledPlugins: [],
        externalSkills: [],
        externalPlugins: [],
        archiveEntries: ['manifest.json'],
      };
    });

    await cli.main(['agent', 'export', 'main']);

    expect(selections).toEqual([{ mode: 'skip' }, { mode: 'skip' }]);
    expect(readlineQuestion).toHaveBeenCalledTimes(2);
  });

  it('runs agent install with --yes and prints runtime config updates', async () => {
    const { cli, unpackAgent, readlineQuestion } = await importFreshCli();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main([
      'agent',
      'install',
      '/tmp/demo.claw',
      '--id',
      'imported',
      '--yes',
    ]);

    expect(unpackAgent).toHaveBeenCalledWith(
      path.resolve('/tmp/demo.claw'),
      expect.objectContaining({
        agentId: 'imported',
        yes: true,
      }),
    );
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Installed agent imported-agent'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Updated runtime config at'),
    );
  });

  it('runs agent uninstall with --yes and removes the installed agent', async () => {
    const { cli, uninstallAgent } = await importFreshCli({
      agentListResult: [
        { id: 'main', name: 'Main Agent', model: 'gpt-5-mini' },
        { id: 'writer', name: 'Writer Agent', model: 'gpt-5-mini' },
      ],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await cli.main(['agent', 'uninstall', 'writer', '--yes']);

    expect(uninstallAgent).toHaveBeenCalledWith('writer', {
      existingAgent: {
        id: 'writer',
        name: 'Writer Agent',
        model: 'gpt-5-mini',
      },
    });
    expect(logSpy).toHaveBeenCalledWith('Uninstalled agent writer.');
    expect(logSpy).toHaveBeenCalledWith(
      'Removed agent files at /tmp/.hybridclaw/data/agents/writer.',
    );
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
