import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

let homeDir = '';

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-routing-config-'));
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  vi.resetModules();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DISABLE_CONFIG_WATCHER === undefined) {
    delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
  } else {
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER =
      ORIGINAL_DISABLE_CONFIG_WATCHER;
  }
});

async function loadConfigModule() {
  return import('../src/config/runtime-config.js');
}

describe('model routing runtime config', () => {
  test('normalizes a valid ordered ladder and local endpoint metadata', async () => {
    const configModule = await loadConfigModule();
    const draft = configModule.getRuntimeConfig();
    draft.local.endpoints = [
      {
        name: 'haigpu1',
        type: 'vllm',
        enabled: true,
        baseUrl: 'http://haigpu1:8000/v1',
        zone: 'hai',
        pricing: {
          inputEurPerMillion: 0.4,
          outputEurPerMillion: 1.2,
        },
      },
      {
        name: 'unclassified',
        type: 'vllm',
        enabled: true,
        baseUrl: 'http://unclassified:8000/v1',
      },
    ];
    draft.routing = {
      ...draft.routing,
      enabled: true,
      tiers: [
        { name: 'small', models: ['haigpu1/qwen3.7-27b'] },
        { name: 'frontier', models: ['hybridai/gpt-5'] },
      ],
      defaultStart: 'small',
      escalationStickyTurns: 5,
    };

    const saved = configModule.saveRuntimeConfig(draft);

    expect(saved.routing).toMatchObject({
      enabled: true,
      defaultStart: 'small',
      escalationStickyTurns: 5,
      tiers: [
        { name: 'small', models: ['haigpu1/qwen3.7-27b'] },
        { name: 'frontier', models: ['hybridai/gpt-5'] },
      ],
    });
    expect(saved.local.endpoints[0]).toMatchObject({
      zone: 'hai',
      pricing: {
        inputEurPerMillion: 0.4,
        outputEurPerMillion: 1.2,
      },
    });
    expect(saved.local.endpoints[1]?.zone).toBe('cloud');
  });

  test('rejects an enabled empty ladder', async () => {
    const configModule = await loadConfigModule();
    const draft = configModule.getRuntimeConfig();
    draft.routing.enabled = true;
    draft.routing.tiers = [];

    expect(() => configModule.saveRuntimeConfig(draft)).toThrow(
      'routing.tiers must not be empty',
    );
  });

  test('rejects duplicate tier names', async () => {
    const configModule = await loadConfigModule();
    const draft = configModule.getRuntimeConfig();
    draft.routing.enabled = true;
    draft.routing.tiers = [
      { name: 'same', models: ['hybridai/gpt-5-mini'] },
      { name: 'SAME', models: ['hybridai/gpt-5'] },
    ];
    draft.routing.defaultStart = 'same';

    expect(() => configModule.saveRuntimeConfig(draft)).toThrow(
      'Duplicate routing tier name',
    );
  });

  test('rejects unknown model references', async () => {
    const configModule = await loadConfigModule();
    const draft = configModule.getRuntimeConfig();
    draft.routing.enabled = true;
    draft.routing.tiers = [
      { name: 'only', models: ['hybridai/not-in-the-catalog'] },
    ];
    draft.routing.defaultStart = 'only';

    expect(() => configModule.saveRuntimeConfig(draft)).toThrow(
      'references unknown model',
    );
  });
});

 test('routing visibility is opt-in and survives normalization', async () => {
   const config = await loadConfigModule();
   expect(config.getRuntimeConfig().routing.showRoutingInfo).toBe(false);
   const saved = config.updateRuntimeConfig((draft) => { draft.routing.showRoutingInfo = true; });
   expect(saved.routing.showRoutingInfo).toBe(true);
 });

test('saves a newly discovered model when registered with its tier in the same update', async () => {
  const config = await loadConfigModule();
  const draft = config.getRuntimeConfig();
  const model = 'anthropic/new-catalog-model';
  draft.routing.enabled = true;
  draft.routing.tiers = [{ name: 'cloud', models: [model] }];
  draft.routing.defaultStart = 'cloud';
  expect(() => config.saveRuntimeConfig(draft)).toThrow('references unknown model');
  draft.anthropic.models.push(model);
  const saved = config.saveRuntimeConfig(draft);
  expect(saved.routing.tiers[0].models).toEqual([model]);
  expect(saved.anthropic.models).toContain(model);
  config.reloadRuntimeConfig();
  expect(config.getRuntimeConfig().routing.tiers[0].models).toEqual([model]);
});

test('evaluator defaults off and preserves explicit shadow settings', async () => {
  const config = await loadConfigModule();
  expect(config.getRuntimeConfig().routing.evaluator.mode).toBe('off');
  const saved = config.updateRuntimeConfig(draft => {
    draft.routing.evaluator = { mode: 'shadow', model: 'jev-latest', timeoutMs: 1200, minConfidence: 0.9, publicPrompts: ['Explain photosynthesis.'] };
  });
  expect(saved.routing.evaluator.publicPrompts).toEqual(['Explain photosynthesis.']);
  config.reloadRuntimeConfig();
  expect(config.getRuntimeConfig().routing.evaluator.mode).toBe('shadow');
});

test('unified mode and preferences validate and discard profile model assignments', async () => {
 const { getRuntimeConfig, updateRuntimeConfig } = await loadConfigModule();
 updateRuntimeConfig(draft => { draft.routing.mode='cost';Object.assign(draft.routing,{preference:'no_hurry'});draft.routing.concierge={model:'jev/jev-latest'};});
 expect(getRuntimeConfig().routing).toMatchObject({mode:'cost',concierge:{model:'jev/jev-latest'}});
 expect(getRuntimeConfig().routing).not.toHaveProperty('preference');
 expect(getRuntimeConfig().routing.concierge).not.toHaveProperty('profiles');
 expect(() => updateRuntimeConfig(draft => { Object.assign(draft.routing,{mode:'arbitrary'}); })).toThrow('Invalid routing option');
});

test('rejects saving Privacy without a local tier model and preserves saved config', async () => {
 const mod=await loadConfigModule();
 const before=mod.getRuntimeConfig();
 const draft=structuredClone(before);
 draft.routing.mode='privacy';draft.routing.maximumZone='local';draft.routing.concierge={model:'',comparisonModel:''};
 draft.routing.tiers=[];
 expect(()=>mod.saveRuntimeConfig(draft)).toThrow('Configure a local model first');
 expect(mod.getRuntimeConfig().routing.mode).toBe(before.routing.mode);
 draft.local.backends.ollama.enabled=true;
 draft.routing.tiers=[{name:'local',models:['ollama/test-model']}];
 draft.routing.defaultStart='local';
 expect(mod.saveRuntimeConfig(draft).routing.mode).toBe('privacy');
 draft.local.backends.ollama.enabled=false;
 expect(()=>mod.saveRuntimeConfig(draft)).toThrow('Configure a local model first');
});

test('rejects endpoint edits and unreachable privacy tiers without changing disk or active config', async () => {
  const mod = await loadConfigModule();
  const draft = mod.getRuntimeConfig();
  draft.local.backends.ollama.enabled = true;
  draft.routing.enabled = true;
  draft.routing.tiers = [{ name: 'local', models: ['ollama/test-model'] }];
  draft.routing.defaultStart = 'local';
  const saved = mod.saveRuntimeConfig(draft);
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  const stored = fs.readFileSync(configPath, 'utf8');
  const listener = vi.fn();
  const unsubscribe = mod.onRuntimeConfigChange(listener);
  expect(() => mod.updateRuntimeConfig(next => {
    next.local.backends.ollama.enabled = false;
  })).toThrow('needs an enabled model');
  const invalid = structuredClone(saved);
  invalid.routing.mode = 'privacy';
  invalid.routing.maximumZone = 'local';
  invalid.routing.concierge={model:'',comparisonModel:''};
  invalid.routing.tiers.push({ name: 'higher', models: ['hybridai/gpt-5'] });
  expect(() => mod.saveRuntimeConfig(invalid)).toThrow('Configure a local model first');
  expect(fs.readFileSync(configPath, 'utf8')).toBe(stored);
  expect(mod.getRuntimeConfig()).toEqual(saved);
  expect(listener).not.toHaveBeenCalled();
  unsubscribe();
  invalid.routing.tiers[1].models.push('ollama/test-model');
  expect(mod.saveRuntimeConfig(invalid).routing.mode).toBe('privacy');
});

test('rejects disabling a configured router endpoint', async () => {
  const mod = await loadConfigModule();
  const draft = mod.getRuntimeConfig();
  draft.local.backends.ollama.enabled = true;
  draft.routing.enabled = true;
  draft.routing.tiers = [{ name: 'cloud', models: ['hybridai/gpt-5'] }];
  draft.routing.defaultStart = 'cloud';
  draft.routing.concierge.model = 'ollama/test-router';
  mod.saveRuntimeConfig(draft);
  draft.local.backends.ollama.enabled = false;
  expect(() => mod.saveRuntimeConfig(draft)).toThrow('disabled or outside the selected privacy limit');
});

test('failed persistence leaves active values and explicit-setting metadata intact', async () => {
  const mod = await loadConfigModule();
  const saved = mod.saveRuntimeConfig(mod.getRuntimeConfig());
  const explicit = mod.isContainerMaxConcurrentExplicit();
  const draft = structuredClone(saved);
  draft.container.maxConcurrent = saved.container.maxConcurrent + 1;
  const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('test write failure');
  });
  try {
    expect(() => mod.saveRuntimeConfig(draft)).toThrow('test write failure');
    expect(mod.getRuntimeConfig()).toEqual(saved);
    expect(mod.isContainerMaxConcurrentExplicit()).toBe(explicit);
  } finally {
    rename.mockRestore();
  }
});

test('mode assignments persist and invalid inactive models cannot be saved', async () => {
  const mod = await loadConfigModule();
  const draft = mod.getRuntimeConfig();
  draft.routing.enabled = true;
  draft.routing.tiers = [{ name: 'general', models: ['hybridai/gpt-5'], modelsByMode: { cost: ['hybridai/gpt-5-mini'] } }];
  draft.routing.defaultStart = 'general';
  draft.routing.mode = 'cost';
  const saved = mod.saveRuntimeConfig(draft);
  mod.reloadRuntimeConfig();
  expect(mod.getRuntimeConfig().routing.tiers).toEqual(saved.routing.tiers);
  draft.routing.tiers[0].modelsByMode = { privacy: ['unknown/no-model'] };
  expect(() => mod.saveRuntimeConfig(draft)).toThrow('Unknown privacy routing model');
  expect(mod.getRuntimeConfig().routing.tiers).toEqual(saved.routing.tiers);
});

test('an explicit privacy boundary survives reload', async () => {
  const mod = await loadConfigModule();
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  const source = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  source.routing = { ...source.routing, mode: 'privacy', maximumZone: 'hai' };
  fs.writeFileSync(configPath, JSON.stringify(source));
  mod.reloadRuntimeConfig();
  expect(mod.getRuntimeConfig().routing.maximumZone).toBe('hai');
});

test('rejects an unknown privacy limit without changing the saved configuration', async () => {
  const mod = await loadConfigModule();
  const before = mod.getRuntimeConfig();
  expect(() => mod.updateRuntimeConfig(draft => { Object.assign(draft.routing, {maximumZone:'unknown'}); })).toThrow('Invalid routing option');
  expect(mod.getRuntimeConfig().routing.maximumZone).toBe(before.routing.maximumZone);
});
