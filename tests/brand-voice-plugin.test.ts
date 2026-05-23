import fs from 'node:fs';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import type {
  PluginOutputGuardContext,
  PluginOutputGuardOutcome,
} from '../src/plugins/plugin-types.js';
import { useTempDir } from './test-utils.ts';

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: vi.fn(async () => ({
    provider: 'hybridai',
    model: 'test-brand-voice-classifier',
    content: JSON.stringify({
      verdict: 'on_brand',
      reasons: [],
      severity: 'low',
    }),
  })),
}));

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
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('brand-voice rules detect banned phrases, banned patterns, and missing required phrases', async () => {
  const { buildVoiceBrief, resolveBrandVoiceConfig } = await import(
    '../plugins/brand-voice/src/config.js'
  );
  const { detectRuleViolations } = await import(
    '../plugins/brand-voice/src/rules.js'
  );

  const config = resolveBrandVoiceConfig(
    {
      mode: 'block',
      doList: ['Use concrete examples'],
      dontList: ['Use hype'],
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
  expect(buildVoiceBrief(config)).toContain('Do:\n- Use concrete examples');
  expect(buildVoiceBrief(config)).toContain("Don't:\n- Use hype");

  const onBrand = detectRuleViolations(
    'Thanks for reaching out — we will follow up Tuesday.\n\nBest regards',
    config,
  );
  expect(onBrand).toEqual([]);
});

test('brand-voice plugin registers post-receive middleware via PluginManager', async () => {
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

  expect(manager.hasMiddleware('post_receive')).toBe(true);
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
  expect(outcome.resultText).toBe(
    'Brand-voice violations: banned phrases: "stupid"',
  );
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

  const auxiliary = await import('../src/providers/auxiliary.js');
  vi.mocked(auxiliary.callAuxiliaryModel).mockImplementation(
    async (request) => {
      const systemPrompt = String(request.messages[0]?.content || '');
      if (systemPrompt.includes('brand-voice rewriter')) {
        return {
          provider: 'hybridai',
          model: 'hybridai/default-chat',
          content:
            'We hold ourselves to a high bar and we will keep you posted.',
        };
      }
      return {
        provider: 'hybridai',
        model: 'hybridai/default-chat',
        content: JSON.stringify({
          verdict: 'on_brand',
          reasons: [],
          severity: 'low',
        }),
      };
    },
  );

  const runtimeConfig = loadRuntimeConfig();
  runtimeConfig.plugins.list = [
    {
      id: 'brand-voice',
      enabled: true,
      config: {
        mode: 'rewrite',
        bannedPhrases: ['stupid'],
        rewriter: {
          provider: 'default',
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
  expect(auxiliary.callAuxiliaryModel).toHaveBeenCalledTimes(2);
  expect(auxiliary.callAuxiliaryModel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      provider: 'auto',
      model: undefined,
    }),
  );
});

test('brand-voice guard defaults rewrite mode to the default model', async () => {
  const homeDir = makeTempDir('hybridclaw-brand-voice-home-');
  const cwd = makeTempDir('hybridclaw-brand-voice-project-');
  installBundledPlugin(cwd);

  const auxiliary = await import('../src/providers/auxiliary.js');
  vi.mocked(auxiliary.callAuxiliaryModel).mockImplementation(
    async (request) => {
      const systemPrompt = String(request.messages[0]?.content || '');
      if (systemPrompt.includes('brand-voice rewriter')) {
        return {
          provider: 'hybridai',
          model: 'hybridai/default-chat',
          content: 'That question is not aligned with the launch plan.',
        };
      }
      return {
        provider: 'hybridai',
        model: 'hybridai/default-chat',
        content: JSON.stringify({
          verdict: 'on_brand',
          reasons: [],
          severity: 'low',
        }),
      };
    },
  );

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

  expect(outcome.blocked).toBe(false);
  expect(outcome.resultText).toBe(
    'That question is not aligned with the launch plan.',
  );
  expect(outcome.events[0]).toMatchObject({ action: 'rewrite' });
  expect(auxiliary.callAuxiliaryModel).toHaveBeenLastCalledWith(
    expect.objectContaining({
      provider: 'auto',
    }),
  );
});

test('brand-voice guard warns and leaves output unchanged when mode=flag', async () => {
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
  expect(outcome.events).toEqual([
    expect.objectContaining({
      action: 'warn',
      pluginId: 'brand-voice',
      guardId: 'brand-voice',
      reason: 'Brand-voice violations: banned phrases: "stupid"',
    }),
  ]);
});
