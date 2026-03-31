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
  process.chdir(homeDir);
  vi.resetModules();
  return import('../src/migration/legacy-home-migration.ts');
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

  fs.mkdirSync(skillsRoot, { recursive: true });
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
          },
        },
        channels: {
          discord: {
            token: 'discord-openclaw-token',
            allowFrom: ['123456789'],
            prefix: '!legacy',
          },
          whatsapp: {
            allowFrom: ['+49123456789'],
          },
        },
        models: {
          providers: {
            hybridai: {
              apiKey: 'hai-openclaw-key',
            },
            openrouter: {
              apiKey: '${OPENROUTER_API_KEY}',
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
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'SOUL.md'),
    '# SOUL.md\n\nLegacy OpenClaw soul.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'AGENTS.md'),
    '# AGENTS.md\n\nLegacy workspace rules.\n',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(skillsRoot, 'SKILL.md'),
    '---\nname: brand-voice\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateLegacyHome({
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
  expect(result.outputDir).toBeTruthy();
  expect(fs.existsSync(path.join(result.outputDir || '', 'report.json'))).toBe(
    true,
  );
  expect((config.hybridai as { defaultModel: string }).defaultModel).toBe(
    'openrouter/anthropic/claude-sonnet-4',
  );
  expect((config.openrouter as { enabled: boolean }).enabled).toBe(true);
  expect(
    (config.discord as { commandAllowedUserIds: string[] })
      .commandAllowedUserIds,
  ).toContain('123456789');
  expect((config.discord as { prefix: string }).prefix).toBe('!legacy');
  expect((config.whatsapp as { allowFrom: string[] }).allowFrom).toContain(
    '+49123456789',
  );
  expect(
    (
      config.mcpServers as Record<string, { command: string; args: string[] }>
    ).github.command,
  ).toBe('npx');
  expect((credentials.OPENROUTER_API_KEY as string) || '').toBe(
    'or-openclaw',
  );
  expect((credentials.HYBRIDAI_API_KEY as string) || '').toBe(
    'hai-openclaw-key',
  );
  expect((credentials.DISCORD_TOKEN as string) || '').toBe(
    'discord-openclaw-token',
  );
  expect(fs.readFileSync(path.join(mainWorkspace, 'SOUL.md'), 'utf-8')).toContain(
    'Legacy OpenClaw soul.',
  );
  expect(
    fs.readFileSync(path.join(mainWorkspace, 'AGENTS.md'), 'utf-8'),
  ).toContain('Legacy workspace rules.');
  expect(
    fs.existsSync(path.join(runtimeRoot, 'skills', 'brand-voice', 'SKILL.md')),
  ).toBe(true);
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
    path.join(skillsRoot, 'SKILL.md'),
    '---\nname: release-helper\ndescription: Imported skill\n---\n\nSkill body.\n',
    'utf-8',
  );

  const migration = await importFreshMigrator(homeDir);
  const result = await migration.migrateLegacyHome({
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
  expect((config.hybridai as { defaultModel: string }).defaultModel).toBe(
    'huggingface/meta-llama/Llama-3.1-8B-Instruct',
  );
  expect((config.huggingface as { enabled: boolean }).enabled).toBe(true);
  expect(
    (
      config.mcpServers as Record<string, { command: string; args: string[] }>
    ).docs.command,
  ).toBe('uvx');
  expect((credentials.HYBRIDAI_API_KEY as string) || '').toBe(
    'hai-hermes-key',
  );
  expect((credentials.DISCORD_TOKEN as string) || '').toBe(
    'discord-hermes-token',
  );
  expect(fs.readFileSync(path.join(mainWorkspace, 'SOUL.md'), 'utf-8')).toContain(
    'Hermes identity.',
  );
  expect(
    fs.existsSync(
      path.join(runtimeRoot, 'skills', 'release-helper', 'SKILL.md'),
    ),
  ).toBe(true);
});
