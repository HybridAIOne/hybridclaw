import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.ts';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-config-models-'));
}

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: RuntimeConfig) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
  config.ops.dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshConfig(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/config/config.ts');
}

const ORIGINAL_HYBRIDAI_CHATBOT_ID = process.env.HYBRIDAI_CHATBOT_ID;

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
  if (ORIGINAL_HYBRIDAI_CHATBOT_ID === undefined) {
    delete process.env.HYBRIDAI_CHATBOT_ID;
  } else {
    process.env.HYBRIDAI_CHATBOT_ID = ORIGINAL_HYBRIDAI_CHATBOT_ID;
  }
});

describe('env var overrides', () => {
  it('HYBRIDAI_CHATBOT_ID env var overrides config.json value', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.hybridai.defaultChatbotId = 'from-config';
    });
    process.env.HYBRIDAI_CHATBOT_ID = 'from-env';
    const config = await importFreshConfig(homeDir);
    expect(config.HYBRIDAI_CHATBOT_ID).toBe('from-env');
  });

  it('falls back to config.json when HYBRIDAI_CHATBOT_ID is not set', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.hybridai.defaultChatbotId = 'from-config';
    });
    delete process.env.HYBRIDAI_CHATBOT_ID;
    const config = await importFreshConfig(homeDir);
    expect(config.HYBRIDAI_CHATBOT_ID).toBe('from-config');
  });

  it('treats whitespace-only HYBRIDAI_CHATBOT_ID as unset', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.hybridai.defaultChatbotId = 'from-config';
    });
    process.env.HYBRIDAI_CHATBOT_ID = '   ';
    const config = await importFreshConfig(homeDir);
    expect(config.HYBRIDAI_CHATBOT_ID).toBe('from-config');
  });
});

describe('configured model catalog', () => {
  it('preserves provider model lists in the runtime config snapshot', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.hybridai.models = ['gpt-5-nano', 'shared-model', 'gpt-5'];
      config.codex.models = ['shared-model', 'openai-codex/gpt-5.4'];
      config.openrouter.enabled = true;
      config.openrouter.models = [
        'shared-model',
        'openrouter/anthropic/claude-sonnet-4',
      ];
      config.mistral.enabled = true;
      config.mistral.models = ['shared-model', 'mistral/mistral-large-latest'];
      config.huggingface.enabled = true;
      config.huggingface.models = [
        'shared-model',
        'huggingface/meta-llama/Llama-3.1-8B-Instruct',
      ];
    });

    const config = await importFreshConfig(homeDir);
    const snapshot = config.getConfigSnapshot();

    expect(snapshot.hybridai.models).toEqual([
      'gpt-5-nano',
      'shared-model',
      'gpt-5',
    ]);
    expect(snapshot.codex.models).toEqual([
      'shared-model',
      'openai-codex/gpt-5.4',
    ]);
    expect(config.OPENROUTER_ENABLED).toBe(true);
    expect(snapshot.openrouter.models).toEqual([
      'shared-model',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    expect(config.MISTRAL_ENABLED).toBe(true);
    expect(snapshot.mistral.models).toEqual([
      'shared-model',
      'mistral/mistral-large-latest',
    ]);
    expect(config.HUGGINGFACE_ENABLED).toBe(true);
    expect(snapshot.huggingface.models).toEqual([
      'shared-model',
      'huggingface/meta-llama/Llama-3.1-8B-Instruct',
    ]);
  });

  it('deep-clones exported mutable runtime objects', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      config.discord.humanDelay = {
        mode: 'custom',
        minMs: 1200,
        maxMs: 3400,
      };
      config.discord.guilds = {
        guildA: {
          defaultMode: 'mention',
          channels: {
            channelA: {
              mode: 'free',
              humanDelay: {
                mode: 'natural',
                minMs: 500,
                maxMs: 1500,
              },
            },
          },
        },
      };
      config.mcpServers = {
        filesystem: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/demo'],
          enabled: true,
        },
      };
    });

    const config = await importFreshConfig(homeDir);
    config.DISCORD_HUMAN_DELAY.minMs = 9999;
    config.DISCORD_GUILDS.guildA.channels.channelA.mode = 'off';
    config.MCP_SERVERS.filesystem?.args?.push('--mutated');

    const snapshot = config.getConfigSnapshot();

    expect(snapshot.discord.humanDelay.minMs).toBe(1200);
    expect(snapshot.discord.guilds.guildA.channels.channelA.mode).toBe('free');
    expect(snapshot.mcpServers.filesystem?.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-filesystem',
      '/tmp/demo',
    ]);
  });
});
