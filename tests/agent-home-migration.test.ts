import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_HYBRIDAI_API_KEY = process.env.HYBRIDAI_API_KEY;
const ORIGINAL_DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ORIGINAL_BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const TEMP_HOMES: string[] = [];

function makeTempHome(): string {
  const homeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-migration-'),
  );
  TEMP_HOMES.push(homeDir);
  return homeDir;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
    string,
    unknown
  >;
}

async function importFreshMigrator(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  delete process.env.HYBRIDAI_API_KEY;
  delete process.env.DISCORD_TOKEN;
  delete process.env.BRAVE_API_KEY;
  process.chdir(homeDir);
  vi.resetModules();
  return import('../src/migration/agent-home-migration.ts');
}

afterEach(() => {
  vi.restoreAllMocks();
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
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_HYBRIDAI_API_KEY === undefined) {
    delete process.env.HYBRIDAI_API_KEY;
  } else {
    process.env.HYBRIDAI_API_KEY = ORIGINAL_HYBRIDAI_API_KEY;
  }
  if (ORIGINAL_DISCORD_TOKEN === undefined) {
    delete process.env.DISCORD_TOKEN;
  } else {
    process.env.DISCORD_TOKEN = ORIGINAL_DISCORD_TOKEN;
  }
  if (ORIGINAL_BRAVE_API_KEY === undefined) {
    delete process.env.BRAVE_API_KEY;
  } else {
    process.env.BRAVE_API_KEY = ORIGINAL_BRAVE_API_KEY;
  }
  while (TEMP_HOMES.length > 0) {
    const homeDir = TEMP_HOMES.pop();
    if (!homeDir) continue;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test('migrates compatible OpenClaw state into HybridClaw', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.openclaw');
  const workspaceRoot = path.join(sourceRoot, 'workspace');
  const skillsRoot = path.join(workspaceRoot, 'skills', 'brand-voice');
  const workspaceAgentsSkillRoot = path.join(
    workspaceRoot,
    '.agents',
    'skills',
    'workspace-helper',
  );
  const sharedAgentsSkillRoot = path.join(
    homeDir,
    '.agents',
    'skills',
    'shared-helper',
  );
  const dailyMemoryRoot = path.join(workspaceRoot, 'memory');
  const authProfilesRoot = path.join(sourceRoot, 'agents', 'main', 'agent');

  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.mkdirSync(workspaceAgentsSkillRoot, { recursive: true });
  fs.mkdirSync(sharedAgentsSkillRoot, { recursive: true });
  fs.mkdirSync(dailyMemoryRoot, { recursive: true });
  fs.mkdirSync(authProfilesRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, '.env'),
    'OPENROUTER_API_KEY=or-openclaw\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'openclaw.json'),
    `${JSON.stringify(
      {
        agents: {
          defaults: {
            model: 'openrouter/anthropic/claude-sonnet-4',
            enableRag: false,
            humanDelay: {
              mode: 'custom',
              minMs: 1200,
              maxMs: 2400,
            },
            userTimezone: 'America/New_York',
            sandbox: {
              backend: 'docker',
              docker: {
                image: 'ghcr.io/example/openclaw-runtime:latest',
              },
            },
          },
        },
        channels: {
          discord: {
            token: 'discord-openclaw-token',
            allowFrom: ['123456789'],
            prefix: '!openclaw',
            groupPolicy: 'allowlist',
            textChunkLimit: 1900,
            intents: {
              presence: true,
              guildMembers: true,
            },
            autoPresence: {
              enabled: true,
              intervalMs: 45_000,
              healthyText: 'Available',
              degradedText: 'Degraded',
              exhaustedText: 'Busy',
              activityType: 3,
            },
            guilds: {
              'guild-1': {
                requireMention: true,
                users: ['user-a'],
                roles: ['role-a'],
                channels: {
                  'channel-1': {
                    requireMention: false,
                    users: ['user-b'],
                    roles: ['role-b'],
                  },
                  'channel-2': {
                    enabled: false,
                  },
                },
              },
            },
          },
          whatsapp: {
            allowFrom: ['+49123456789'],
          },
        },
        models: {
          providers: {
            hybridai: {
              apiKey: 'hai-openclaw-key',
              baseUrl: 'https://hybrid.example/api',
              models: ['gpt-5'],
            },
            openrouter: {
              apiKey: '$' + '{OPENROUTER_API_KEY}',
              baseUrl: 'https://openrouter.example/v1',
              models: ['openrouter/anthropic/claude-sonnet-4'],
            },
            ollama: {
              baseUrl: 'http://127.0.0.1:11434',
            },
            customapi: {
              apiKey: 'custom-provider-key',
              baseUrl: 'https://custom-provider.example/v1',
            },
          },
        },
        mcp: {
          servers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
            },
          },
        },
        tools: {
          exec: {
            timeoutSec: 42,
          },
          web: {
            search: {
              provider: 'brave',
              maxResults: 7,
              cacheTtlMinutes: 12,
            },
          },
        },
        messages: {
          inbound: {
            byChannel: {
              discord: 1600,
            },
          },
          ackReaction: '✅',
          ackReactionScope: 'group-all',
          removeAckAfterReply: true,
          statusReactions: {
            enabled: true,
          },
        },
        session: {
          dmScope: 'per-channel-peer',
          identityLinks: {
            alice: ['discord:user-123', 'email:boss@example.com'],
          },
          typingMode: 'message',
          reset: {
            mode: 'both',
            atHour: 6,
            idleMinutes: 120,
          },
          resetByChannel: {
            discord: {
              mode: 'idle',
              idleMinutes: 60,
            },
          },
        },
        gateway: {
          baseUrl: 'https://gateway.example',
          auth: {
            token: 'gateway-openclaw-token',
            webApiToken: 'web-openclaw-token',
          },
        },
        logging: {
          level: 'debug',
        },
        plugins: {
          entries: {
            example: {
              enabled: true,
              config: {
                mode: 'strict',
              },
            },
            'disabled-plugin': {
              enabled: false,
            },
          },
        },
        skills: {
          load: {
            extraDirs: ['/tmp/openclaw-extra-skills'],
          },
          entries: {
            'archived-skill': {
              enabled: false,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'SOUL.md'),
    '# SOUL.md\n\nImported OpenClaw soul.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'AGENTS.md'),
    '# AGENTS.md\n\nImported workspace rules.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'MEMORY.md'),
    [
      '# MEMORY.md',
      '',
      '## Facts',
      '',
      '- Loves strong coffee.',
      '',
      '## Decisions',
      '',
      '- Use strict TypeScript defaults.',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'USER.md'),
    ['# USER.md', '', '## Notes', '', '- Prefers concise answers.', ''].join(
      '\n',
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dailyMemoryRoot, '2026-03-30.md'),
    ['# 2026-03-30', '', '- Shipped the Discord gateway refactor.', ''].join(
      '\n',
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(skillsRoot, 'SKILL.md'),
    '---\nname: brand-voice\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceAgentsSkillRoot, 'SKILL.md'),
    '---\nname: workspace-helper\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sharedAgentsSkillRoot, 'SKILL.md'),
    '---\nname: shared-helper\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(authProfilesRoot, 'auth-profiles.json'),
    JSON.stringify(
      {
        profiles: {
          huggingface: {
            key: 'hf-auth-profile-token',
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'exec-approvals.json'),
    JSON.stringify(
      {
        agents: {
          main: {
            allowlist: [{ pattern: 'git status' }],
          },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateAgentHome({
    sourceKind: 'openclaw',
    sourceRoot,
    migrateSecrets: true,
  });

  const runtimeRoot = path.join(homeDir, '.hybridclaw');
  const config = readJson(path.join(runtimeRoot, 'config.json'));
  const credentials = readJson(path.join(runtimeRoot, 'credentials.json'));
  const mainWorkspace = path.join(
    runtimeRoot,
    'data',
    'agents',
    'main',
    'workspace',
  );

  expect(result.summary.migrated).toBeGreaterThan(0);
  expect(result.targetAgentId).toBe('main');
  expect(result.outputDir).toBeTruthy();
  expect(fs.existsSync(path.join(result.outputDir || '', 'report.json'))).toBe(
    true,
  );
  expect((config.hybridai as { defaultModel: string }).defaultModel).toBe(
    'openrouter/anthropic/claude-sonnet-4',
  );
  expect((config.hybridai as { baseUrl: string }).baseUrl).toBe(
    'https://hybrid.example/api',
  );
  expect((config.hybridai as { enableRag: boolean }).enableRag).toBe(false);
  expect((config.openrouter as { enabled: boolean }).enabled).toBe(true);
  expect((config.openrouter as { baseUrl: string }).baseUrl).toBe(
    'https://openrouter.example/v1',
  );
  expect(
    (config.local as { backends: { ollama: { enabled: boolean } } }).backends
      .ollama.enabled,
  ).toBe(true);
  expect(
    (config.discord as { commandAllowedUserIds: string[] })
      .commandAllowedUserIds,
  ).toEqual([]);
  expect((config.discord as { prefix: string }).prefix).toBe('!openclaw');
  expect((config.discord as { groupPolicy: string }).groupPolicy).toBe('open');
  expect((config.discord as { textChunkLimit: number }).textChunkLimit).toBe(
    1900,
  );
  expect((config.discord as { presenceIntent: boolean }).presenceIntent).toBe(
    true,
  );
  expect(
    (config.discord as { guildMembersIntent: boolean }).guildMembersIntent,
  ).toBe(true);
  expect(
    (
      config.discord as {
        humanDelay: { mode: string; minMs: number; maxMs: number };
      }
    ).humanDelay,
  ).toEqual({
    mode: 'natural',
    minMs: 800,
    maxMs: 2500,
  });
  expect((config.discord as { debounceMs: number }).debounceMs).toBe(2500);
  expect((config.discord as { ackReaction: string }).ackReaction).toBe('👀');
  expect(
    (config.discord as { ackReactionScope: string }).ackReactionScope,
  ).toBe('group-mentions');
  expect(
    (config.discord as { removeAckAfterReply: boolean }).removeAckAfterReply,
  ).toBe(true);
  expect(
    (
      config.discord as {
        lifecycleReactions: { enabled: boolean };
      }
    ).lifecycleReactions.enabled,
  ).toBe(true);
  expect(
    (
      config.discord as {
        presence: {
          enabled: boolean;
          intervalMs: number;
          healthyText: string;
          degradedText: string;
          exhaustedText: string;
          activityType: string;
        };
      }
    ).presence,
  ).toMatchObject({
    enabled: true,
    intervalMs: 30_000,
    healthyText: 'Watching the channels',
    degradedText: 'Thinking slowly...',
    exhaustedText: 'Taking a break',
    activityType: 'watching',
  });
  expect(
    (config.discord as { guilds: Record<string, unknown> }).guilds,
  ).toEqual({});
  expect((config.whatsapp as { allowFrom: string[] }).allowFrom).toContain(
    '+49123456789',
  );
  expect((config.whatsapp as { dmPolicy: string }).dmPolicy).toBe('pairing');
  expect(
    (
      config.sessionReset as {
        defaultPolicy: { mode: string; atHour: number; idleMinutes: number };
      }
    ).defaultPolicy,
  ).toEqual({
    mode: 'both',
    atHour: 4,
    idleMinutes: 1440,
  });
  expect(
    (
      config.sessionReset as {
        byChannelKind: Record<string, { mode: string; idleMinutes: number }>;
      }
    ).byChannelKind.discord,
  ).toBeUndefined();
  expect(
    (
      config.sessionRouting as {
        dmScope: string;
        identityLinks: Record<string, string[]>;
      }
    ).dmScope,
  ).toBe('per-channel-peer');
  expect(
    (
      config.sessionRouting as {
        dmScope: string;
        identityLinks: Record<string, string[]>;
      }
    ).identityLinks,
  ).toEqual({
    alice: ['discord:user-123', 'email:boss@example.com'],
  });
  expect(
    (
      config.proactive as {
        activeHours: { timezone: string };
      }
    ).activeHours.timezone,
  ).toBe('');
  expect((config.container as { image: string }).image).toBe(
    'hybridclaw-agent',
  );
  expect((config.container as { timeoutMs: number }).timeoutMs).toBe(300_000);
  expect(
    result.items.some(
      (item) => item.kind === 'config:container' && item.status === 'migrated',
    ),
  ).toBe(false);
  expect(
    (
      config.web as {
        search: {
          provider: string;
          defaultCount: number;
          cacheTtlMinutes: number;
        };
      }
    ).search,
  ).toMatchObject({
    provider: 'auto',
    defaultCount: 7,
    cacheTtlMinutes: 12,
  });
  expect((config.ops as { gatewayBaseUrl: string }).gatewayBaseUrl).toBe(
    'https://gateway.example',
  );
  expect((config.ops as { webApiToken: string }).webApiToken).toBe(
    'web-openclaw-token',
  );
  expect((config.ops as { logLevel: string }).logLevel).toBe('debug');
  expect(
    (config.mcpServers as Record<string, { command: string; args: string[] }>)
      .github.command,
  ).toBe('npx');
  expect((credentials.OPENROUTER_API_KEY as string) || '').toBe('or-openclaw');
  expect((credentials.HYBRIDAI_API_KEY as string) || '').toBe(
    'hai-openclaw-key',
  );
  expect((credentials.DISCORD_TOKEN as string) || '').toBe(
    'discord-openclaw-token',
  );
  expect((credentials.GATEWAY_API_TOKEN as string) || '').toBe(
    'gateway-openclaw-token',
  );
  expect((credentials.HF_TOKEN as string) || '').toBe('hf-auth-profile-token');
  expect((config.skills as { extraDirs: string[] }).extraDirs).toContain(
    '/tmp/openclaw-extra-skills',
  );
  expect((config.skills as { disabled: string[] }).disabled).toEqual([]);
  expect(
    (
      config.plugins as {
        list: Array<{
          id: string;
          enabled: boolean;
          config: Record<string, unknown>;
        }>;
      }
    ).list,
  ).toEqual([]);
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'SOUL.md'), 'utf-8'),
  ).toContain('Imported OpenClaw soul.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'AGENTS.md'), 'utf-8'),
  ).toContain('Imported workspace rules.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'MEMORY.md'), 'utf-8'),
  ).toContain('Loves strong coffee.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'MEMORY.md'), 'utf-8'),
  ).toContain('Shipped the Discord gateway refactor.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'USER.md'), 'utf-8'),
  ).toContain('Prefers concise answers.');
  expect(fs.existsSync(path.join(mainWorkspace, 'IDENTITY.md'))).toBe(false);
  expect(
    fs.existsSync(path.join(runtimeRoot, 'skills', 'brand-voice', 'SKILL.md')),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(runtimeRoot, 'skills', 'workspace-helper', 'SKILL.md'),
    ),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(runtimeRoot, 'skills', 'shared-helper', 'SKILL.md'),
    ),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(result.outputDir || '', 'archive', 'openclaw.json'),
    ),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(result.outputDir || '', 'archive', 'exec-approvals.json'),
    ),
  ).toBe(true);
  expect(
    fs.existsSync(
      path.join(result.outputDir || '', 'archive', 'openclaw.json'),
    ),
  ).toBe(true);
  expect(
    result.items.some(
      (item) =>
        item.kind === 'archive' &&
        item.source === path.join(sourceRoot, 'openclaw.json'),
    ),
  ).toBe(true);
  expect(
    result.items.some(
      (item) =>
        item.kind === 'config:providers' &&
        item.status === 'skipped' &&
        Array.isArray(item.details?.providers) &&
        item.details.providers.includes('customapi'),
    ),
  ).toBe(true);
  expect(
    result.items.some((item) => item.kind === 'config:session-reset'),
  ).toBe(false);
  expect(result.items.some((item) => item.kind === 'config:timezone')).toBe(
    false,
  );
  expect(result.items.some((item) => item.kind === 'config:plugins')).toBe(
    false,
  );
});

test('migrates compatible Hermes Agent state into HybridClaw', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.hermes');
  const skillsRoot = path.join(sourceRoot, 'skills', 'release-helper');

  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, '.env'),
    [
      'HYBRIDAI_API_KEY=hai-hermes-key',
      'DISCORD_BOT_TOKEN=discord-hermes-token',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'config.yaml'),
    [
      'model: huggingface/meta-llama/Llama-3.1-8B-Instruct',
      'mcp_servers:',
      '  docs:',
      '    command: uvx',
      '    args:',
      '      - docs-mcp',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'SOUL.md'),
    '# SOUL.md\n\nHermes identity.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'MEMORY.md'),
    '# MEMORY.md\n\n- Hermes memory entry.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'USER.md'),
    '# USER.md\n\n- Hermes user note.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(skillsRoot, 'SKILL.md'),
    '---\nname: release-helper\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateAgentHome({
    sourceKind: 'hermes',
    sourceRoot,
    migrateSecrets: true,
  });

  const runtimeRoot = path.join(homeDir, '.hybridclaw');
  const config = readJson(path.join(runtimeRoot, 'config.json'));
  const credentials = readJson(path.join(runtimeRoot, 'credentials.json'));
  const mainWorkspace = path.join(
    runtimeRoot,
    'data',
    'agents',
    'main',
    'workspace',
  );

  expect(result.summary.migrated).toBeGreaterThan(0);
  expect(result.targetAgentId).toBe('main');
  expect((config.hybridai as { defaultModel: string }).defaultModel).toBe(
    'huggingface/meta-llama/Llama-3.1-8B-Instruct',
  );
  expect((config.huggingface as { enabled: boolean }).enabled).toBe(true);
  expect(
    (config.mcpServers as Record<string, { command: string; args: string[] }>)
      .docs.command,
  ).toBe('uvx');
  expect((credentials.HYBRIDAI_API_KEY as string) || '').toBe('hai-hermes-key');
  expect((credentials.DISCORD_TOKEN as string) || '').toBe(
    'discord-hermes-token',
  );
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'SOUL.md'), 'utf-8'),
  ).toContain('Hermes identity.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'MEMORY.md'), 'utf-8'),
  ).toContain('Hermes memory entry.');
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'USER.md'), 'utf-8'),
  ).toContain('Hermes user note.');
  expect(
    fs.existsSync(
      path.join(runtimeRoot, 'skills', 'release-helper', 'SKILL.md'),
    ),
  ).toBe(true);
});

test('migrates into a specific HybridClaw agent when `agentId` is provided', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.hermes');

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'SOUL.md'),
    '# SOUL.md\n\nWriter persona.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(sourceRoot, 'MEMORY.md'),
    '# MEMORY.md\n\n- Prefers long-form drafting.\n',
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const { initDatabase } = await import('../src/memory/db.ts');
  const { listAgents } = await import('../src/agents/agent-registry.ts');
  initDatabase({ quiet: true });
  const result = await migration.migrateAgentHome({
    sourceKind: 'hermes',
    sourceRoot,
    agentId: 'writer',
  });

  const runtimeRoot = path.join(homeDir, '.hybridclaw');
  const config = readJson(path.join(runtimeRoot, 'config.json'));
  const writerWorkspace = path.join(
    runtimeRoot,
    'data',
    'agents',
    'writer',
    'workspace',
  );

  expect(result.targetAgentId).toBe('writer');
  expect(
    fs.readFileSync(path.join(writerWorkspace, 'SOUL.md'), 'utf-8'),
  ).toContain('Writer persona.');
  expect(
    fs.readFileSync(path.join(writerWorkspace, 'MEMORY.md'), 'utf-8'),
  ).toContain('Prefers long-form drafting.');
  expect((config.agents as { list: Array<{ id: string }> }).list).toEqual(
    expect.arrayContaining([{ id: 'writer' }]),
  );
  expect(listAgents().map((agent) => agent.id)).toContain('writer');
});

test('dry-run migration does not create target skill directories', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.hermes');
  const skillsRoot = path.join(sourceRoot, 'skills', 'release-helper');

  fs.mkdirSync(skillsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'SOUL.md'),
    '# SOUL.md\n\nPreview only.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(skillsRoot, 'SKILL.md'),
    '---\nname: release-helper\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateAgentHome({
    sourceKind: 'hermes',
    sourceRoot,
    execute: false,
  });

  const runtimeRoot = path.join(homeDir, '.hybridclaw');
  const skillItem = result.items.find((item) => item.kind === 'skill');
  expect(skillItem?.status).toBe('migrated');
  expect(skillItem?.details?.dryRun).toBe(true);
  expect(fs.existsSync(path.join(runtimeRoot, 'skills'))).toBe(false);
  expect(
    fs.existsSync(
      path.join(runtimeRoot, 'data', 'agents', 'main', 'workspace'),
    ),
  ).toBe(false);
});

test('reports secrets already up to date when incoming values match', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.hermes');
  const runtimeRoot = path.join(homeDir, '.hybridclaw');

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, '.env'),
    'HYBRIDAI_API_KEY=hai-same-value\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(runtimeRoot, 'credentials.json'),
    `${JSON.stringify({ HYBRIDAI_API_KEY: 'hai-same-value' }, null, 2)}\n`,
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateAgentHome({
    sourceKind: 'hermes',
    sourceRoot,
    execute: false,
    migrateSecrets: true,
  });

  const secretsItem = result.items.find((item) => item.kind === 'secrets');
  expect(secretsItem?.status).toBe('skipped');
  expect(secretsItem?.reason).toBe('Secrets already up to date');
  expect(secretsItem?.details?.unchangedKeys).toEqual(['HYBRIDAI_API_KEY']);
});

test('treats directory destinations as workspace conflicts instead of throwing', async () => {
  const homeDir = makeTempHome();
  const sourceRoot = path.join(homeDir, '.hermes');
  const destinationRoot = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'agents',
    'main',
    'workspace',
    'SOUL.md',
  );

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, 'SOUL.md'),
    '# SOUL.md\n\nIncoming soul.\n',
    'utf-8',
  );
  fs.mkdirSync(destinationRoot, { recursive: true });

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateAgentHome({
    sourceKind: 'hermes',
    sourceRoot,
    execute: false,
  });

  const soulItem = result.items.find(
    (item) =>
      item.kind === 'workspace-file' && item.destination === destinationRoot,
  );
  expect(soulItem?.status).toBe('conflict');
  expect(soulItem?.reason).toBe('Destination is not a regular file');
});
