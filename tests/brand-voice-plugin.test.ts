import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import type {
  PluginOutputGuardContext,
  PluginOutputGuardOutcome,
} from '../src/plugins/plugin-types.js';
import { useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'brand-voice');
  const targetDir = path.join(cwd, '.hybridclaw', 'plugins', 'brand-voice');
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

const baseGuardContext: Omit<PluginOutputGuardContext, 'resultText'> = {
  sessionId: 'session-1',
  userId: 'user-1',
  agentId: 'main',
  channelId: 'web',
  userContent: 'Tell me about the launch.',
};

afterEach(() => {
  delete process.env.BRAND_VOICE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
  vi.resetModules();
});

test('brand-voice rules detect banned phrases, banned patterns, and missing required phrases', async () => {
  const { resolveBrandVoiceConfig } = await import(
    '../plugins/brand-voice/src/config.js'
  );
  const { detectRuleViolations } = await import(
    '../plugins/brand-voice/src/rules.js'
  );

  const config = resolveBrandVoiceConfig(
    {
      mode: 'block',
      bannedPhrases: ['Synergy'],
      bannedPatterns: ['/\\bguarantee[sd]?\\b/i'],
      requirePhrases: ['Best regards'],
    },
    { cwd: process.cwd(), homeDir: process.cwd() },
    {
      warn: () => {},
      info: () => {},
      debug: () => {},
      error: () => {},
    } as never,
  );

  const offBrand = detectRuleViolations(
    'We deliver synergy. We guarantee zero downtime.',
    config,
  );
  expect(offBrand.map((entry) => entry.kind).sort()).toEqual([
    'banned_pattern',
    'banned_phrase',
    'missing_required',
  ]);

  const onBrand = detectRuleViolations(
    'Thanks for reaching out — we will follow up Tuesday.\n\nBest regards',
    config,
  );
  expect(onBrand).toEqual([]);
});

test('brand-voice plugin registers an output guard via PluginManager', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'block',
        bannedPhrases: ['stupid'],
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });

  await manager.ensureInitialized();

  expect(manager.hasOutputGuards()).toBe(true);
  expect(manager.getLoadedPlugins()).toEqual([
    expect.objectContaining({
      id: 'brand-voice',
      enabled: true,
      status: 'loaded',
    }),
  ]);
});

test('brand-voice guard blocks responses with banned phrases when mode=block', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'block',
        bannedPhrases: ['stupid'],
        blockMessage: 'Response held by brand-voice guard.',
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome: PluginOutputGuardOutcome = await manager.applyOutputGuards({
    ...baseGuardContext,
    resultText: "That's a stupid question, but here is the answer: 42.",
  });

  expect(outcome.blocked).toBe(true);
  expect(outcome.resultText).toBe('Response held by brand-voice guard.');
  expect(outcome.events).toHaveLength(1);
  expect(outcome.events[0]).toMatchObject({
    pluginId: 'brand-voice',
    guardId: 'brand-voice',
    action: 'block',
  });
});

test('brand-voice guard allows clean output unchanged', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'block',
        bannedPhrases: ['guaranteed'],
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    ...baseGuardContext,
    resultText:
      'Thanks for the question — the launch is on track for next Tuesday.',
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe(
    'Thanks for the question — the launch is on track for next Tuesday.',
  );
  expect(outcome.events).toEqual([
    expect.objectContaining({ action: 'allow', guardId: 'brand-voice' }),
  ]);
});

test('brand-voice guard rewrites off-brand text via the configured rewriter', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  process.env.BRAND_VOICE_API_KEY = 'test-brand-voice-key';

  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url.includes('/v1/messages')) {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'We hold ourselves to a high bar and we will keep you posted.',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const runtimeConfig = loadRuntimeConfig();
  runtimeConfig.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'rewrite',
        bannedPhrases: ['stupid'],
        rewriter: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          apiKeyEnv: 'BRAND_VOICE_API_KEY',
          timeoutMs: 5000,
        },
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => runtimeConfig,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    ...baseGuardContext,
    resultText: "That's a stupid question, but the launch is on Tuesday.",
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe(
    'We hold ourselves to a high bar and we will keep you posted.',
  );
  expect(outcome.events).toHaveLength(1);
  expect(outcome.events[0]).toMatchObject({
    action: 'rewrite',
    pluginId: 'brand-voice',
    guardId: 'brand-voice',
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const fetchCall = fetchMock.mock.calls[0];
  const requestUrl =
    typeof fetchCall[0] === 'string'
      ? fetchCall[0]
      : (fetchCall[0] as URL).toString();
  expect(requestUrl).toContain('/v1/messages');
  const fetchInit = (fetchCall[1] || {}) as RequestInit;
  expect((fetchInit.headers as Record<string, string>)['x-api-key']).toBe(
    'test-brand-voice-key',
  );
});

test('brand-voice guard falls back to block when rewriter is unconfigured', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'rewrite',
        bannedPhrases: ['stupid'],
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    ...baseGuardContext,
    resultText: 'That is a stupid question.',
  });

  expect(outcome.blocked).toBe(true);
  expect(outcome.events[0]).toMatchObject({ action: 'block' });
});

test('brand-voice guard remains transparent when mode=flag', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const config = loadRuntimeConfig();
  config.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'flag',
        bannedPhrases: ['stupid'],
      },
    },
  ];

  const { PluginManager } = await import('../src/plugins/plugin-manager.js');
  const manager = new PluginManager({
    homeDir,
    cwd,
    getRuntimeConfig: () => config,
  });
  await manager.ensureInitialized();

  const outcome = await manager.applyOutputGuards({
    ...baseGuardContext,
    resultText: 'That is a stupid question.',
  });

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe('That is a stupid question.');
});
