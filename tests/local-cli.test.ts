import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_WHATSAPP_SETUP_SETTLE_MS =
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-cli-'));
}

async function importFreshCli(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS = '0';
  vi.resetModules();
  vi.doMock('../src/channels/whatsapp/connection.ts', () => ({
    createWhatsAppConnectionManager: () => ({
      getSocket: () => null,
      start: async () => {},
      stop: async () => {},
      waitForSocket: async () => ({
        user: { id: 'test@s.whatsapp.net' },
      }),
    }),
  }));
  return import('../src/cli.ts');
}

function readRuntimeConfig(homeDir: string): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function readRuntimeSecrets(homeDir: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(
      path.join(homeDir, '.hybridclaw', 'credentials.json'),
      'utf-8',
    ),
  ) as Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/channels/whatsapp/connection.ts');
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_DISABLE_CONFIG_WATCHER === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
      ORIGINAL_DISABLE_CONFIG_WATCHER;
  }
  if (ORIGINAL_WHATSAPP_SETUP_SETTLE_MS === undefined) {
    delete process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS;
  } else {
    process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS =
      ORIGINAL_WHATSAPP_SETUP_SETTLE_MS;
  }
});

test('local configure lmstudio enables the backend and normalizes the URL', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main([
    'local',
    'configure',
    'lmstudio',
    'qwen/qwen3.5-9b',
    '--base-url',
    'http://127.0.0.1:1234',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.lmstudio.enabled).toBe(true);
  expect(config.local.backends.lmstudio.baseUrl).toBe(
    'http://127.0.0.1:1234/v1',
  );
  expect(config.hybridai.defaultModel).toBe('lmstudio/qwen/qwen3.5-9b');
  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Updated runtime config at'),
  );
});

test('local configure --no-default preserves the existing default model', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'local',
    'configure',
    'lmstudio',
    'qwen/qwen3.5-9b',
    '--base-url',
    'http://127.0.0.1:1234',
    '--no-default',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.lmstudio.enabled).toBe(true);
  expect(config.hybridai.defaultModel).toBe('gpt-5-nano');
});

test('help local prints local command usage', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['help', 'local']);

  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Usage: hybridclaw local <command>'),
  );
});

test('channels discord setup configures restricted command-only mode by default', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['channels', 'discord', 'setup']);

  const config = readRuntimeConfig(homeDir);
  expect(config.discord.commandsOnly).toBe(true);
  expect(config.discord.commandMode).toBe('restricted');
  expect(config.discord.commandAllowedUserIds).toEqual([]);
  expect(config.discord.commandUserId).toBe('');
  expect(config.discord.groupPolicy).toBe('disabled');
  expect(config.discord.freeResponseChannels).toEqual([]);
  expect(config.discord.guilds).toEqual({});
  expect(logSpy).toHaveBeenCalledWith('Discord mode: command-only');
});

test('channels discord setup stores the token and allowlisted guild users', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'channels',
    'discord',
    'setup',
    '--token',
    'discord-token-123',
    '--allow-user-id',
    '<@123456789012345678>',
    '--allow-user-id=987654321098765432',
    '--prefix',
    '?claw',
  ]);

  const config = readRuntimeConfig(homeDir);
  const secrets = readRuntimeSecrets(homeDir);
  expect(config.discord.commandsOnly).toBe(true);
  expect(config.discord.commandMode).toBe('restricted');
  expect(config.discord.commandAllowedUserIds).toEqual([
    '123456789012345678',
    '987654321098765432',
  ]);
  expect(config.discord.prefix).toBe('?claw');
  expect(secrets.DISCORD_TOKEN).toBe('discord-token-123');
});

test('channels whatsapp setup configures self-chat-only mode by default', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['channels', 'whatsapp', 'setup']);

  const config = readRuntimeConfig(homeDir);
  expect(config.whatsapp.dmPolicy).toBe('disabled');
  expect(config.whatsapp.groupPolicy).toBe('disabled');
  expect(config.whatsapp.allowFrom).toEqual([]);
  expect(config.whatsapp.groupAllowFrom).toEqual([]);
  expect(config.whatsapp.ackReaction).toBe('👀');
  expect(logSpy).toHaveBeenCalledWith('WhatsApp mode: self-chat only');
  expect(logSpy).toHaveBeenCalledWith('Ack reaction: 👀');
  expect(logSpy).not.toHaveBeenCalledWith('Next:');
});

test('channels whatsapp setup normalizes allowlisted DM numbers', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'channels',
    'whatsapp',
    'setup',
    '--allow-from',
    '+49 170 1234567',
    '--allow-from=+1 (202) 555-0101',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.whatsapp.dmPolicy).toBe('allowlist');
  expect(config.whatsapp.groupPolicy).toBe('disabled');
  expect(config.whatsapp.allowFrom).toEqual(['+491701234567', '+12025550101']);
  expect(config.whatsapp.ackReaction).toBe('👀');
});

test('channels whatsapp setup preserves an existing custom ack reaction', async () => {
  const homeDir = makeTempHome();
  const configDir = path.join(homeDir, '.hybridclaw');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        version: 10,
        security: {
          trustModelAccepted: false,
          trustModelAcceptedAt: '',
          trustModelVersion: '',
          trustModelAcceptedBy: '',
        },
        agents: {
          defaults: {},
          list: [{ id: 'main' }],
        },
        skills: { extraDirs: [], disabled: [] },
        discord: {
          prefix: '!claw',
          guildMembersIntent: false,
          presenceIntent: false,
          commandsOnly: false,
          commandMode: 'public',
          commandAllowedUserIds: [],
          commandUserId: '',
          groupPolicy: 'open',
          sendPolicy: 'open',
          sendAllowedChannelIds: [],
          freeResponseChannels: [],
          textChunkLimit: 2000,
          maxLinesPerMessage: 17,
          humanDelay: { mode: 'natural', minMs: 800, maxMs: 2500 },
          typingMode: 'thinking',
          presence: {
            enabled: true,
            intervalMs: 30000,
            healthyText: 'Watching the channels',
            degradedText: 'Thinking slowly...',
            exhaustedText: 'Taking a break',
            activityType: 'watching',
          },
          lifecycleReactions: {
            enabled: true,
            removeOnComplete: true,
            phases: {
              queued: '⏳',
              thinking: '🤔',
              toolUse: '⚙️',
              streaming: '✍️',
              done: '✅',
              error: '❌',
            },
          },
          ackReaction: '👀',
          ackReactionScope: 'group-mentions',
          removeAckAfterReply: true,
          debounceMs: 2500,
          rateLimitPerUser: 0,
          rateLimitExemptRoles: [],
          suppressPatterns: ['/stop', '/pause', 'brb', 'afk'],
          maxConcurrentPerChannel: 2,
          guilds: {},
        },
        whatsapp: {
          dmPolicy: 'pairing',
          groupPolicy: 'disabled',
          allowFrom: [],
          groupAllowFrom: [],
          textChunkLimit: 4000,
          debounceMs: 2500,
          sendReadReceipts: true,
          ackReaction: '✅',
          mediaMaxMb: 20,
        },
        hybridai: {
          baseUrl: 'https://hybridai.one',
          defaultModel: 'gpt-5-nano',
          defaultChatbotId: '',
          maxTokens: 4096,
          enableRag: true,
          models: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
        },
        codex: {
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          models: ['openai-codex/gpt-5-codex'],
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
          discovery: {
            enabled: true,
            intervalMs: 3600000,
            maxModels: 200,
            concurrency: 8,
          },
          healthCheck: {
            enabled: true,
            intervalMs: 60000,
            timeoutMs: 5000,
          },
          defaultContextWindow: 128000,
          defaultMaxTokens: 8192,
        },
        container: {
          sandboxMode: 'container',
          image: 'hybridclaw-agent',
          memory: '512m',
          memorySwap: '',
          cpus: '1',
          network: 'bridge',
          timeoutMs: 300000,
          binds: [],
          additionalMounts: '',
          maxOutputBytes: 10485760,
          maxConcurrent: 5,
        },
        mcpServers: {},
        observability: {
          enabled: false,
          botId: '',
          agentId: '',
        },
        memory: {
          maxShortTermMessages: 200,
          consolidationIntervalHours: 24,
          decayRate: 0.05,
          retrievalLimit: 8,
        },
        scheduler: {
          jobs: [],
        },
        heartbeat: {
          enabled: false,
          intervalMs: 600000,
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const cli = await importFreshCli(homeDir);

  await cli.main(['channels', 'whatsapp', 'setup']);

  const config = readRuntimeConfig(homeDir);
  expect(config.whatsapp.ackReaction).toBe('✅');
});

test('channels whatsapp setup --reset clears stale auth files before pairing', async () => {
  const homeDir = makeTempHome();
  const authDir = path.join(homeDir, '.hybridclaw', 'credentials', 'whatsapp');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{"stale":true}', 'utf-8');

  const cli = await importFreshCli(homeDir);

  await cli.main(['channels', 'whatsapp', 'setup', '--reset']);

  expect(fs.existsSync(path.join(authDir, 'creds.json'))).toBe(false);
});

test('auth whatsapp reset clears stale auth files without pairing', async () => {
  const homeDir = makeTempHome();
  const authDir = path.join(homeDir, '.hybridclaw', 'credentials', 'whatsapp');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'creds.json'), '{"stale":true}', 'utf-8');

  const cli = await importFreshCli(homeDir);

  await cli.main(['auth', 'whatsapp', 'reset']);

  expect(fs.existsSync(path.join(authDir, 'creds.json'))).toBe(false);
  expect(fs.existsSync(authDir)).toBe(true);
});
