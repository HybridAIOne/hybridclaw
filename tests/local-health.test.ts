import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-local-health-'));
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
  config.local.enabled = true;
  config.local.backends.ollama.enabled = true;
  config.local.backends.lmstudio.enabled = true;
  config.local.backends.vllm.enabled = false;
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

async function importFreshHealth(homeDir: string) {
  process.env.HOME = homeDir;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
  vi.resetModules();
  return import('../src/providers/local-health.js');
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const health = await import('../src/providers/local-health.js');
  health.resetLocalHealthState();
});

describe('local health checks', () => {
  test('checkConnection reports reachable backends with model counts', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const health = await importFreshHealth(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{}, {}] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: [{}, {}, {}] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const ollama = await health.checkConnection(
      'ollama',
      'http://127.0.0.1:11434/v1',
      5_000,
    );
    const lmstudio = await health.checkConnection(
      'lmstudio',
      'http://127.0.0.1:1234/v1',
      5_000,
    );

    expect(ollama).toMatchObject({
      backend: 'ollama',
      reachable: true,
      modelCount: 2,
    });
    expect(lmstudio).toMatchObject({
      backend: 'lmstudio',
      reachable: true,
      modelCount: 3,
    });
    expect(ollama.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('checkConnection returns unreachable status on network error', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const health = await importFreshHealth(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    const result = await health.checkConnection(
      'ollama',
      'http://127.0.0.1:11434',
      100,
    );

    expect(result).toMatchObject({
      backend: 'ollama',
      reachable: false,
      error: 'connect ECONNREFUSED',
    });
  });

  test('checkModelConnection sends a minimal inference request', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const health = await importFreshHealth(homeDir);

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ollamaResult = await health.checkModelConnection(
      'ollama',
      'http://127.0.0.1:11434',
      'llama3.2',
      5_000,
    );
    const ollamaBody = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body || '{}'),
    ) as Record<string, unknown>;
    expect(ollamaBody).toMatchObject({
      model: 'llama3.2',
      stream: false,
      options: { num_predict: 1 },
    });
    expect(ollamaResult.usable).toBe(true);

    await health.checkModelConnection(
      'lmstudio',
      'http://127.0.0.1:1234/v1',
      'qwen2.5-coder',
      5_000,
    );
    const lmstudioBody = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body || '{}'),
    ) as Record<string, unknown>;
    expect(lmstudioBody).toMatchObject({
      model: 'qwen2.5-coder',
      max_tokens: 1,
      stream: false,
    });
  });

  test('checkAllBackends updates cached health results', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir);
    const health = await importFreshHealth(homeDir);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.endsWith('/api/tags')) {
          return new Response(JSON.stringify({ models: [{ id: 'a' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ data: [{ id: 'b' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const map = await health.checkAllBackends();

    expect(map.get('ollama')).toMatchObject({ reachable: true, modelCount: 1 });
    expect(map.get('lmstudio')).toMatchObject({
      reachable: true,
      modelCount: 1,
    });
    expect(health.getBackendHealth('ollama')).toMatchObject({
      reachable: true,
    });
  });
});
