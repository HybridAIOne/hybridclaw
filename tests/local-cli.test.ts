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
const ORIGINAL_MSTEAMS_APP_ID = process.env.MSTEAMS_APP_ID;
const ORIGINAL_MSTEAMS_APP_PASSWORD = process.env.MSTEAMS_APP_PASSWORD;
const ORIGINAL_MSTEAMS_TENANT_ID = process.env.MSTEAMS_TENANT_ID;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-cli-'));
}

async function importFreshCli(
  homeDir: string,
  options?: {
    imessageLocalReadyError?: Error | null;
  },
) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  process.env.HYBRIDCLAW_WHATSAPP_SETUP_SETTLE_MS = '0';
  vi.resetModules();
  vi.doMock('../src/channels/imessage/local-prereqs.js', () => ({
    assertLocalIMessageBackendReady: vi.fn(() => {
      if (options?.imessageLocalReadyError) {
        throw options.imessageLocalReadyError;
      }
    }),
    formatMissingIMessageCliMessage: vi.fn((cliPath: string) => cliPath),
  }));
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

async function readRuntimeSecrets(
  homeDir: string,
): Promise<Record<string, string | null>> {
  process.env.HOME = homeDir;
  vi.resetModules();
  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');
  return {
    DISCORD_TOKEN: runtimeSecrets.readStoredRuntimeSecret('DISCORD_TOKEN'),
    EMAIL_PASSWORD: runtimeSecrets.readStoredRuntimeSecret('EMAIL_PASSWORD'),
    IMESSAGE_PASSWORD:
      runtimeSecrets.readStoredRuntimeSecret('IMESSAGE_PASSWORD'),
    MSTEAMS_APP_PASSWORD: runtimeSecrets.readStoredRuntimeSecret(
      'MSTEAMS_APP_PASSWORD',
    ),
    VLLM_API_KEY: runtimeSecrets.readStoredRuntimeSecret('VLLM_API_KEY'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/channels/imessage/local-prereqs.js');
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

test('local configure llamacpp enables the backend and normalizes the URL', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'local',
    'configure',
    'llamacpp',
    'Meta-Llama-3-8B-Instruct',
    '--base-url',
    'http://127.0.0.1:8081',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.llamacpp.enabled).toBe(true);
  expect(config.local.backends.llamacpp.baseUrl).toBe(
    'http://127.0.0.1:8081/v1',
  );
  expect(config.hybridai.defaultModel).toBe(
    'llamacpp/Meta-Llama-3-8B-Instruct',
  );
});

test('local configure without model enables the backend and preserves the default model', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main([
    'local',
    'configure',
    'lmstudio',
    '--base-url',
    'http://127.0.0.1:1234',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.local.backends.lmstudio.enabled).toBe(true);
  expect(config.local.backends.lmstudio.baseUrl).toBe(
    'http://127.0.0.1:1234/v1',
  );
  expect(config.hybridai.defaultModel).toBe('gpt-4.1-mini');
  expect(logSpy).toHaveBeenCalledWith('Configured model: none');
  expect(logSpy).toHaveBeenCalledWith(
    'Default model unchanged: hybridai/gpt-4.1-mini',
  );
  expect(logSpy).toHaveBeenCalledWith('  /model list lmstudio');
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
  expect(config.hybridai.defaultModel).toBe('gpt-4.1-mini');
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

test('help secret prints secret command usage', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['help', 'secret']);

  expect(logSpy).toHaveBeenCalledWith(
    expect.stringContaining('Usage: hybridclaw secret <command>'),
  );
});

test('secret set, show --raw, and unset manage encrypted secrets', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const runtimeSecrets = await import('../src/security/runtime-secrets.ts');

  await cli.main(['secret', 'set', 'SF_FULL_USERNAME', 'user@example.com']);

  expect(runtimeSecrets.readStoredRuntimeSecret('SF_FULL_USERNAME')).toBe(
    'user@example.com',
  );

  logSpy.mockClear();
  await cli.main(['secret', 'show', 'SF_FULL_USERNAME']);
  expect(logSpy.mock.calls.map(([line]) => String(line))).toEqual([
    'Name: SF_FULL_USERNAME',
    'Stored: yes',
    `Path: ${runtimeSecrets.runtimeSecretsPath()}`,
  ]);

  logSpy.mockClear();
  await cli.main(['secret', 'show', 'SF_FULL_USERNAME', '--raw']);
  expect(logSpy).toHaveBeenCalledWith('user@example.com');

  await cli.main(['secret', 'unset', 'SF_FULL_USERNAME']);
  expect(runtimeSecrets.readStoredRuntimeSecret('SF_FULL_USERNAME')).toBeNull();
});

test('secret route add and remove update store-backed auth rules', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'secret',
    'route',
    'add',
    'https://api.example.com/v1',
    'SF_FULL_SECRET',
    'X-API-Key',
    'none',
  ]);

  let config = readRuntimeConfig(homeDir);
  expect(config.tools.httpRequest.authRules).toEqual([
    {
      urlPrefix: 'https://api.example.com/v1/',
      header: 'X-API-Key',
      prefix: '',
      secret: { source: 'store', id: 'SF_FULL_SECRET' },
    },
  ]);

  await cli.main([
    'secret',
    'route',
    'remove',
    'https://api.example.com/v1',
    'X-API-Key',
  ]);

  config = readRuntimeConfig(homeDir);
  expect(config.tools.httpRequest.authRules).toEqual([]);
});

test('top-level help hides deprecated alias commands', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['help']);

  const output = logSpy.mock.calls
    .map(([message]) => String(message))
    .join('\n');
  expect(output).not.toContain('Deprecated alias for local provider');
  expect(output).not.toContain('Deprecated alias for HybridAI provider');
  expect(output).not.toContain('Deprecated alias for Codex provider');
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
  const secrets = await readRuntimeSecrets(homeDir);
  expect(config.discord.commandsOnly).toBe(true);
  expect(config.discord.commandMode).toBe('restricted');
  expect(config.discord.commandAllowedUserIds).toEqual([
    '123456789012345678',
    '987654321098765432',
  ]);
  expect(config.discord.prefix).toBe('?claw');
  expect(secrets.DISCORD_TOKEN).toBe('discord-token-123');
});

test('channels slack manifest prints the slash-command manifest fragment', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main(['channels', 'slack', 'manifest']);

  const output = logSpy.mock.calls
    .map(([message]) => String(message))
    .join('\n');
  expect(output).toContain('oauth_config:');
  expect(output).toContain('command: "/hc-status"');
  expect(output).toContain('- "commands"');
});

test('channels slack register-commands syncs slash commands through Slack app manifests', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/apps.manifest.export')) {
      return new Response(
        JSON.stringify({
          ok: true,
          manifest: {
            display_information: { name: 'HybridClaw Dev' },
            oauth_config: { scopes: { bot: ['chat:write'] } },
            features: {
              slash_commands: [
                {
                  command: '/custom',
                  description: 'Custom command',
                  should_escape: true,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/apps.manifest.update')) {
      const payload = JSON.parse(String(init?.body || '{}')) as {
        manifest?: string;
      };
      const manifest = JSON.parse(String(payload.manifest || '{}')) as {
        oauth_config?: { scopes?: { bot?: string[] } };
        features?: {
          slash_commands?: Array<{ command?: string; description?: string }>;
        };
      };
      expect(manifest.oauth_config?.scopes?.bot).toContain('commands');
      expect(manifest.features?.slash_commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: '/custom' }),
          expect.objectContaining({
            command: '/hc-status',
            description: 'Show HybridClaw runtime status (only visible to you)',
          }),
        ]),
      );
      expect(
        manifest.features?.slash_commands?.some(
          (command) => command.command === '/status',
        ),
      ).toBe(false);
      expect(
        manifest.features?.slash_commands?.some(
          (command) => command.command === '/hybridclaw-status',
        ),
      ).toBe(false);
      return new Response(
        JSON.stringify({
          ok: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await cli.main([
      'channels',
      'slack',
      'register-commands',
      '--app-id',
      'A1234567890',
      '--config-token',
      'xoxe-1234567890',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(logSpy).toHaveBeenCalledWith(
    'Updated Slack app manifest for A1234567890.',
  );
  expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registered'));
});

test('channels email setup writes config and stores EMAIL_PASSWORD', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  await cli.main([
    'channels',
    'email',
    'setup',
    '--address',
    'agent@example.com',
    '--password',
    'email-app-password',
    '--imap-host',
    'imap.example.com',
    '--smtp-host',
    'smtp.example.com',
    '--allow-from',
    'boss@example.com',
    '--allow-from',
    '*@example.com',
    '--folder',
    'INBOX',
    '--folder',
    'Support',
  ]);

  const config = readRuntimeConfig(homeDir);
  const rawConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const rawEmail = rawConfig.email as Record<string, unknown>;
  const secrets = await readRuntimeSecrets(homeDir);
  expect(config.email.enabled).toBe(true);
  expect(config.email.address).toBe('agent@example.com');
  expect(config.email.imapHost).toBe('imap.example.com');
  expect(config.email.imapSecure).toBe(true);
  expect(config.email.smtpHost).toBe('smtp.example.com');
  expect(config.email.smtpSecure).toBe(false);
  expect(rawEmail.password).toEqual({
    source: 'store',
    id: 'EMAIL_PASSWORD',
  });
  expect(config.email.folders).toEqual(['INBOX', 'Support']);
  expect(config.email.allowFrom).toEqual(['boss@example.com', '*@example.com']);
  expect(secrets.EMAIL_PASSWORD).toBe('email-app-password');
  expect(logSpy).toHaveBeenCalledWith(
    `Updated runtime config at ${path.join(homeDir, '.hybridclaw', 'config.json')}`,
  );
  expect(logSpy).toHaveBeenCalledWith(
    `Saved email password to ${path.join(homeDir, '.hybridclaw', 'credentials.json')}`,
  );
});

test('channels imessage setup configures the local backend with safe defaults', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'channels',
    'imessage',
    'setup',
    '--allow-from',
    '+14155551212',
  ]);

  const config = readRuntimeConfig(homeDir);
  expect(config.imessage.enabled).toBe(true);
  expect(config.imessage.backend).toBe('local');
  expect(config.imessage.cliPath).toBe('imsg');
  expect(config.imessage.dbPath).toContain('/Library/Messages/chat.db');
  expect(config.imessage.dmPolicy).toBe('allowlist');
  expect(config.imessage.allowFrom).toEqual(['+14155551212']);
  expect(config.imessage.groupPolicy).toBe('disabled');
  expect(config.imessage.groupAllowFrom).toEqual([]);
});

test('channels imessage setup configures the remote backend and stores IMESSAGE_PASSWORD', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'channels',
    'imessage',
    'setup',
    '--backend',
    'remote',
    '--server-url',
    'https://bluebubbles.example.com',
    '--password',
    'bluebubbles-password',
    '--allow-from',
    'user@example.com',
  ]);

  const config = readRuntimeConfig(homeDir);
  const rawConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const rawIMessage = rawConfig.imessage as Record<string, unknown>;
  const secrets = await readRuntimeSecrets(homeDir);
  expect(config.imessage.enabled).toBe(true);
  expect(config.imessage.backend).toBe('bluebubbles');
  expect(config.imessage.serverUrl).toBe('https://bluebubbles.example.com');
  expect(rawIMessage.password).toEqual({
    source: 'store',
    id: 'IMESSAGE_PASSWORD',
  });
  expect(config.imessage.dmPolicy).toBe('allowlist');
  expect(config.imessage.allowFrom).toEqual(['user@example.com']);
  expect(config.imessage.groupPolicy).toBe('disabled');
  expect(secrets.IMESSAGE_PASSWORD).toBe('bluebubbles-password');
});

test('local configure vllm stores api key in runtime secrets and writes a store ref', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'local',
    'configure',
    'vllm',
    'meta-llama/Llama-3.1-8B-Instruct',
    '--base-url',
    'http://127.0.0.1:8000',
    '--api-key',
    'vllm-secret-key',
  ]);

  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  const runtimeConfig = await import('../src/config/runtime-config.ts');
  const config = runtimeConfig.getRuntimeConfig();
  const rawConfig = JSON.parse(
    fs.readFileSync(path.join(homeDir, '.hybridclaw', 'config.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const rawLocal = rawConfig.local as Record<string, unknown>;
  const rawBackends = rawLocal.backends as Record<string, unknown>;
  const rawVllm = rawBackends.vllm as Record<string, unknown>;
  const secrets = await readRuntimeSecrets(homeDir);

  expect(config.local.backends.vllm.enabled).toBe(true);
  expect(config.local.backends.vllm.baseUrl).toBe('http://127.0.0.1:8000/v1');
  expect(config.local.backends.vllm.apiKey).toBe('vllm-secret-key');
  expect(rawVllm.apiKey).toEqual({
    source: 'store',
    id: 'VLLM_API_KEY',
  });
  expect(config.hybridai.defaultModel).toBe(
    'vllm/meta-llama/Llama-3.1-8B-Instruct',
  );
  expect(secrets.VLLM_API_KEY).toBe('vllm-secret-key');
});

test('channels imessage setup fails fast when the local imsg binary is missing', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir, {
    imessageLocalReadyError: new Error(
      'Missing iMessage CLI binary: imsg. Install it with `brew install steipete/tap/imsg` or rerun `hybridclaw channels imessage setup --cli-path /absolute/path/to/imsg ...`.',
    ),
  });

  await expect(
    cli.main(['channels', 'imessage', 'setup', '--allow-from', '+14155551212']),
  ).rejects.toThrow(/Missing iMessage CLI binary: imsg/);
});

test('auth login msteams writes config and stores MSTEAMS_APP_PASSWORD', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'auth',
    'login',
    'msteams',
    '--app-id',
    'teams-app-id',
    '--tenant-id',
    'teams-tenant-id',
    '--app-password',
    'teams-app-password',
  ]);

  const config = readRuntimeConfig(homeDir);
  const secrets = await readRuntimeSecrets(homeDir);
  expect(config.msteams.enabled).toBe(true);
  expect(config.msteams.appId).toBe('teams-app-id');
  expect(config.msteams.tenantId).toBe('teams-tenant-id');
  expect(secrets.MSTEAMS_APP_PASSWORD).toBe('teams-app-password');
});

test('auth logout msteams clears Teams credentials and disables the integration', async () => {
  const homeDir = makeTempHome();
  const cli = await importFreshCli(homeDir);

  await cli.main([
    'auth',
    'login',
    'msteams',
    '--app-id',
    'teams-app-id',
    '--tenant-id',
    'teams-tenant-id',
    '--app-password',
    'teams-app-password',
  ]);
  await cli.main(['auth', 'logout', 'msteams']);

  const config = readRuntimeConfig(homeDir);
  const secretsPath = path.join(homeDir, '.hybridclaw', 'credentials.json');
  expect(config.msteams.enabled).toBe(false);
  expect(config.msteams.appId).toBe('');
  expect(config.msteams.tenantId).toBe('');
  if (fs.existsSync(secretsPath)) {
    const secrets = await readRuntimeSecrets(homeDir);
    expect(secrets.MSTEAMS_APP_PASSWORD).toBeNull();
  } else {
    expect(fs.existsSync(secretsPath)).toBe(false);
  }
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
          defaultModel: 'gpt-4.1-mini',
          defaultChatbotId: '',
          maxTokens: 4096,
          enableRag: true,
          models: ['gpt-4.1-mini', 'gpt-5-nano', 'gpt-5-mini', 'gpt-5'],
        },
        codex: {
          baseUrl: 'https://chatgpt.com/backend-api/codex',
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
