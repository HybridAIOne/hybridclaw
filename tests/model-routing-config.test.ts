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
