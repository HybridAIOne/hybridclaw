import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RuntimeConfig } from '../src/config/runtime-config.js';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const makeTempDir = useTempDir();
useCleanMocks({ unstubAllEnvs: true });

// Importing runtime config under the real HOME would migrate the developer's
// live ~/.hybridclaw/config.json.
beforeEach(() => {
  vi.stubEnv('HOME', makeTempDir('hybridclaw-embed-home-'));
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
});

afterEach(async () => {
  const { clearEmbeddingProviders } = await import(
    '../src/memory/embeddings.js'
  );
  clearEmbeddingProviders();
});

function loadRuntimeConfig(): RuntimeConfig {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as RuntimeConfig;
}

function installBundledPlugin(cwd: string): void {
  const sourceDir = path.join(process.cwd(), 'plugins', 'transformers-embeddings');
  const targetDir = path.join(
    cwd,
    '.hybridclaw',
    'plugins',
    'transformers-embeddings',
  );
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function writeHomeConfig(homeDir: string, provider: string): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = loadRuntimeConfig() as unknown as Record<string, unknown>;
  (config.ops as Record<string, unknown>).dbPath = path.join(
    homeDir,
    '.hybridclaw',
    'data',
    'hybridclaw.db',
  );
  delete (config.container as Record<string, unknown>).sandboxMode;
  (config.memory as Record<string, unknown>).embedding = { provider };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function loadMemoryService(provider: string) {
  const homeDir = makeTempDir('hybridclaw-embed-home-');
  writeHomeConfig(homeDir, provider);
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
  vi.resetModules();
  const embeddings = await import('../src/memory/embeddings.js');
  const { MemoryService } = await import('../src/memory/memory-service.js');
  const service = new MemoryService() as InstanceType<typeof MemoryService> & {
    resolveEmbeddingProvider: () => {
      embedQuery?: (text: string) => number[] | null;
    };
  };
  return { embeddings, service };
}

describe('TransformersJsEmbeddingProvider', () => {
  test.each([
    [
      'onnx-community/embeddinggemma-300m-ONNX',
      [
        'task: search result | query: Find Caroline',
        'title: none | text: Caroline moved to Berlin.',
      ],
    ],
    [
      'Xenova/all-MiniLM-L6-v2',
      ['Find Caroline', 'Caroline moved to Berlin.'],
    ],
  ])('formats query and document input for %s', async (model, expected) => {
    const seen: string[] = [];
    const { TransformersJsEmbeddingProvider } = await import(
      '../plugins/transformers-embeddings/src/provider.js'
    );
    const provider = new TransformersJsEmbeddingProvider(
      { model },
      {
        embed(text: string) {
          seen.push(text);
          return [1, 0];
        },
      },
    );

    expect(provider.embedQuery('Find Caroline')).toEqual([1, 0]);
    expect(provider.embedDocument('Caroline moved to Berlin.')).toEqual([1, 0]);
    expect(provider.embedQuery('   ')).toBeNull();
    expect(seen).toEqual(expected);
  });

  test('forwards warmup requests to the blocking runtime', async () => {
    const warmup = vi.fn();
    const { TransformersJsEmbeddingProvider } = await import(
      '../plugins/transformers-embeddings/src/provider.js'
    );
    const provider = new TransformersJsEmbeddingProvider(
      { model: 'Xenova/all-MiniLM-L6-v2' },
      { embed: () => [1], warmup },
    );

    provider.warmup();

    expect(warmup).toHaveBeenCalledTimes(1);
  });
});

describe('transformers-embeddings plugin', () => {
  test('registers the transformers provider with plugin config and unregisters on shutdown', async () => {
    const homeDir = makeTempDir('hybridclaw-embed-plugin-home-');
    const cwd = makeTempDir('hybridclaw-embed-plugin-project-');
    installBundledPlugin(cwd);
    const config = loadRuntimeConfig();
    config.plugins.list = [
      {
        id: 'transformers-embeddings',
        enabled: true,
        config: { model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q4' },
      },
    ];

    const { PluginManager } = await import('../src/plugins/plugin-manager.js');
    const { getEmbeddingProviderRegistration } = await import(
      '../src/memory/embeddings.js'
    );
    const manager = new PluginManager({
      homeDir,
      cwd,
      getRuntimeConfig: () => config,
    });
    await manager.ensureInitialized();

    const registration = getEmbeddingProviderRegistration('transformers');
    expect(registration?.model).toBe('Xenova/all-MiniLM-L6-v2');
    const provider = registration?.create();
    expect(typeof provider?.embedQuery).toBe('function');
    provider?.dispose?.();

    await manager.shutdown();
    expect(getEmbeddingProviderRegistration('transformers')).toBeUndefined();
  });
});

describe('MemoryService embedding provider resolution', () => {
  test('uses the registered plugin provider and rebuilds it after re-registration', async () => {
    const { embeddings, service } = await loadMemoryService('transformers');
    const create = vi.fn(() => ({ embedQuery: () => [0.2, 0.8] }));
    embeddings.registerEmbeddingProvider('transformers-embeddings', {
      id: 'transformers',
      create,
    });

    const first = service.resolveEmbeddingProvider();
    expect(first.embedQuery?.('Who is Caroline?')).toEqual([0.2, 0.8]);
    expect(service.resolveEmbeddingProvider()).toBe(first);

    embeddings.clearEmbeddingProviders();
    embeddings.registerEmbeddingProvider('transformers-embeddings', {
      id: 'transformers',
      create,
    });
    expect(service.resolveEmbeddingProvider()).not.toBe(first);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('fails instead of falling back to hashed when the provider is not registered', async () => {
    const { service } = await loadMemoryService('transformers');

    expect(() => service.resolveEmbeddingProvider()).toThrow(
      /transformers-embeddings/,
    );
  });

  test('rejects registering the built-in hashed id', async () => {
    const { registerEmbeddingProvider } = await import(
      '../src/memory/embeddings.js'
    );

    expect(() =>
      registerEmbeddingProvider('some-plugin', {
        id: 'hashed',
        create: () => ({}),
      }),
    ).toThrow();
  });
});
