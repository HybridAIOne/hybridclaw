import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
useCleanMocks({
  unstubAllEnvs: true,
  unstubAllGlobals: true,
  resetModules: true,
});

test.each([
  { enabled: false, healthEnabled: true, calls: 0 },
  { enabled: true, healthEnabled: false, calls: 0 },
  { enabled: true, healthEnabled: true, calls: 1 },
])(
  'local probes obey activation: %j',
  async ({ enabled, healthEnabled, calls }) => {
    const home = tempDir();
    vi.stubEnv('HOME', home);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    const config = JSON.parse(fs.readFileSync('config.example.json', 'utf8'));
    for (const backend of Object.values(config.local.backends) as {
      enabled: boolean;
    }[]) {
      backend.enabled = false;
    }
    config.local.healthCheck.enabled = healthEnabled;
    config.local.endpoints = [
      {
        name: 'active',
        type: 'vllm',
        baseUrl: 'http://127.0.0.1:18001/v1',
        enabled,
      },
      {
        name: 'inactive',
        type: 'mlx',
        baseUrl: 'http://127.0.0.1:18002/v1',
        enabled: false,
      },
    ];
    config.ops.dbPath = path.join(home, 'test.db');
    fs.mkdirSync(path.join(home, '.hybridclaw'));
    fs.writeFileSync(
      path.join(home, '.hybridclaw/config.json'),
      JSON.stringify(config),
    );
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    vi.stubGlobal('fetch', fetch);
    const { checkAllBackends } = await import(
      '../src/providers/local-health.js'
    );
    const results = await checkAllBackends();
    expect(fetch).toHaveBeenCalledTimes(calls);
    expect([...results.keys()]).toEqual(calls ? ['vllm'] : []);
    if (calls)
      expect(fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:18001/v1/models',
        expect.any(Object),
      );
  },
);
