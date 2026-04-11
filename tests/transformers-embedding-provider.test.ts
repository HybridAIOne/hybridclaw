import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DISABLE_CONFIG_WATCHER =
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-embed-provider-'));
}

function writeRuntimeConfig(
  homeDir: string,
  mutator?: (config: Record<string, unknown>) => void,
): void {
  const configPath = path.join(homeDir, '.hybridclaw', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'config.example.json'), 'utf-8'),
  ) as Record<string, unknown>;
  const ops = config.ops as Record<string, unknown>;
  ops.dbPath = path.join(homeDir, '.hybridclaw', 'data', 'hybridclaw.db');
  delete (config.container as Record<string, unknown>).sandboxMode;
  mutator?.(config);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar(
    'HYBRIDCLAW_DISABLE_CONFIG_WATCHER',
    ORIGINAL_DISABLE_CONFIG_WATCHER,
  );
});

describe('TransformersJsEmbeddingProvider', () => {
  test('applies EmbeddingGemma query and document prompts', async () => {
    const seen: string[] = [];
    const { TransformersJsEmbeddingProvider } = await import(
      '../src/memory/transformers-embedding-provider.js'
    );
    const provider = new TransformersJsEmbeddingProvider(
      {
        model: 'onnx-community/embeddinggemma-300m-ONNX',
        revision: 'rev',
        dtype: 'q8',
        cacheDir: '/tmp/hybridclaw-cache',
      },
      {
        embed(text) {
          seen.push(text);
          return [1, 0];
        },
      },
    );

    expect(provider.embedQuery('Find Caroline')).toEqual([1, 0]);
    expect(provider.embedDocument('Caroline is a trans woman.')).toEqual([
      1, 0,
    ]);
    expect(seen).toEqual([
      'task: search result | query: Find Caroline',
      'title: none | text: Caroline is a trans woman.',
    ]);
  });

  test('leaves non-EmbeddingGemma inputs unchanged', async () => {
    const seen: string[] = [];
    const { TransformersJsEmbeddingProvider } = await import(
      '../src/memory/transformers-embedding-provider.js'
    );
    const provider = new TransformersJsEmbeddingProvider(
      {
        model: 'Xenova/all-MiniLM-L6-v2',
        revision: 'rev',
        dtype: 'q8',
        cacheDir: '/tmp/hybridclaw-cache',
      },
      {
        embed(text) {
          seen.push(text);
          return [1];
        },
      },
    );

    provider.embedQuery('Find Caroline');
    provider.embedDocument('Caroline is a trans woman.');

    expect(seen).toEqual(['Find Caroline', 'Caroline is a trans woman.']);
  });

  test('forwards warmup requests to the blocking runtime', async () => {
    const warmup = vi.fn();
    const { TransformersJsEmbeddingProvider } = await import(
      '../src/memory/transformers-embedding-provider.js'
    );
    const provider = new TransformersJsEmbeddingProvider(
      {
        model: 'onnx-community/embeddinggemma-300m-ONNX',
        revision: 'rev',
        dtype: 'q8',
        cacheDir: '/tmp/hybridclaw-cache',
      },
      {
        embed() {
          return [1, 0];
        },
        warmup,
      },
    );

    provider.warmup();

    expect(warmup).toHaveBeenCalledTimes(1);
  });

  test('MemoryService uses the configured transformers embedding provider', async () => {
    const homeDir = makeTempHome();
    writeRuntimeConfig(homeDir, (config) => {
      const memory = config.memory as Record<string, unknown>;
      memory.embedding = {
        provider: 'transformers',
        model: 'onnx-community/embeddinggemma-300m-ONNX',
        revision: '75a84c732f1884df76bec365346230e32f582c82',
        dtype: 'q4',
      };
    });

    process.env.HOME = homeDir;
    process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
    vi.resetModules();

    const providerOptions: Array<Record<string, unknown>> = [];
    const queryInputs: string[] = [];
    const documentInputs: string[] = [];

    vi.doMock('../src/memory/transformers-embedding-provider.js', () => ({
      TransformersJsEmbeddingProvider: class {
        constructor(options: Record<string, unknown>) {
          providerOptions.push(options);
        }

        embedQuery(text: string) {
          queryInputs.push(text);
          return [0.2, 0.8];
        }

        embedDocument(text: string) {
          documentInputs.push(text);
          return [0.8, 0.2];
        }

        dispose() {}
      },
    }));

    const { MemoryService } = await import('../src/memory/memory-service.js');

    const service = new MemoryService();
    const provider = (
      service as MemoryService & {
        resolveEmbeddingProvider: () => {
          embedQuery: (text: string) => number[] | null;
          embedDocument: (text: string) => number[] | null;
        };
      }
    ).resolveEmbeddingProvider();

    expect(providerOptions).toHaveLength(1);
    expect(providerOptions[0]?.model).toBe(
      'onnx-community/embeddinggemma-300m-ONNX',
    );
    expect(providerOptions[0]?.dtype).toBe('q4');
    expect(provider.embedDocument('Caroline is a trans woman.')).toEqual([
      0.8, 0.2,
    ]);
    expect(provider.embedQuery('Who is Caroline?')).toEqual([0.2, 0.8]);
    expect(documentInputs).toEqual(['Caroline is a trans woman.']);
    expect(queryInputs).toEqual(['Who is Caroline?']);
  });
});
