import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fetchMlx } from '../container/src/providers/mlx-transport.js';
import {
  estimateMacModels,
  estimateMacModelCacheBytes,
  GIB,
  MAC_MODEL_CATALOG,
  parseMacAvailableMemory,
} from '../src/inference/local-model-catalog.js';
import { LOCAL_MODEL_SHORTLIST } from '../src/inference/local-model-shortlist.js';
import { assertMlxEndpoint } from '../src/inference/mlx-endpoint.js';
import { startMlxRelay } from '../src/inference/mlx-relay.js';
import {
  readMlxInstallation,
  startMlxChild,
} from '../src/inference/mlx-runtime.js';
import { claimMlxSetup } from '../src/inference/mlx-setup-lock.js';

const directories: string[] = [];
const relays: Array<ReturnType<typeof startMlxRelay>> = [];
afterEach(() => {
  for (const relay of relays.splice(0)) relay.stop();
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const hardware = {
  platform: 'darwin',
  arch: 'arm64',
  release: '24.0.0',
  chip: 'Example Apple silicon',
};
test.each([
  { model: 'qwen3-4b' },
  { repo: 'example/other-model' },
  { revision: '0'.repeat(40) },
])('rejects installed artifacts outside the pinned shortlist before starting inference: %o', async (override) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-pins-'));
  directories.push(directory);
  const model = MAC_MODEL_CATALOG[0];
  fs.writeFileSync(
    path.join(directory, 'installation.json'),
    JSON.stringify({
      version: 1,
      model: model.id,
      repo: model.repo,
      revision: model.revision,
      license: model.license,
      port: 18323,
      contextWindow: 2048,
      memoryLimitBytes: 4 * GIB,
      cacheBytes: GIB,
      ...override,
    }),
  );
  await expect(startMlxChild(directory)).rejects.toThrow(
    'not in the supported shortlist',
  );
});
test('validates context ceilings before starting an installed model', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-context-'));
  directories.push(directory);
  const spark = MAC_MODEL_CATALOG[0];
  const profile = {
    version: 1,
    model: spark.id,
    repo: spark.repo,
    revision: spark.revision,
    license: spark.license,
    port: 18323,
    contextWindow: 40960,
    memoryLimitBytes: 7 * GIB,
    cacheBytes: 2 * GIB,
  };
  const save = (override: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(directory, 'installation.json'),
      JSON.stringify({ ...profile, ...override }),
    );
  save({});
  expect(readMlxInstallation(directory).contextWindow).toBe(40960);
  for (const contextWindow of [40961, 2047, 8192.5, true]) {
    save({ contextWindow });
    expect(() => readMlxInstallation(directory)).toThrow(
      'Invalid MLX installation',
    );
  }
  const other = MAC_MODEL_CATALOG[1];
  save({ model: other.id, repo: other.repo, revision: other.revision });
  await expect(startMlxChild(directory)).rejects.toThrow('tested limit');
  // A generous current machine cannot override the saved installation budget.
  save({ memoryLimitBytes: 2 * GIB, cacheBytes: GIB });
  const platform = vi.spyOn(os, 'platform').mockReturnValue('darwin');
  const arch = vi.spyOn(os, 'arch').mockReturnValue('arm64');
  const release = vi.spyOn(os, 'release').mockReturnValue('24.0.0');
  try {
    await expect(startMlxChild(directory)).rejects.toThrow(
      'Insufficient available memory',
    );
  } finally {
    platform.mockRestore();
    arch.mockRestore();
    release.mockRestore();
  }
});
describe('Mac memory admission', () => {
  test.each([
    8, 16, 24, 32, 64, 128, 256, 512,
  ])('reserves system memory on a %i GiB Mac', (memory) => {
    const result = estimateMacModels({
      ...hardware,
      memoryBytes: memory * GIB,
    });
    expect(result.reservedBytes).toBeGreaterThanOrEqual(4 * GIB);
    for (const candidate of result.candidates.filter((entry) => entry.fits)) {
      expect(candidate.requiredBytes).toBeLessThanOrEqual(
        result.memoryLimitBytes,
      );
      expect(candidate.contextWindow).toBeLessThanOrEqual(
        candidate.maxContextWindow,
      );
      expect(candidate.requiredBytes).toBeGreaterThan(candidate.weightBytes);
    }
    expect(result.recommended).toBeTruthy();
  });
  test('does not offer models that leave no system headroom', () => {
    expect(
      estimateMacModels({ ...hardware, memoryBytes: 4 * GIB }).recommended,
    ).toBeNull();
    const small = estimateMacModels({ ...hardware, memoryBytes: 8 * GIB });
    expect(small.recommended).toBe('spark-x2.5-4b');
    expect(small.candidates.find((c) => c.id === 'qwen3.8-27b')?.fits).toBe(
      false,
    );
  });
  test('fits Spark agent context using the pinned runtime’s rotating caches', () => {
    const result = estimateMacModels({
      ...hardware,
      memoryBytes: 32 * GIB,
      availableMemoryEstimateBytes: 7 * GIB,
    });
    const spark = result.candidates.find(
      (model) => model.id === 'spark-x2.5-4b',
    )!;
    expect(spark.contextWindow).toBe(32768);
    expect(spark.cacheBytes).toBe(9 * 4096 * 32768 + 27 * 4096 * 768);
    expect(spark.requiredBytes).toBeLessThanOrEqual(6 * GIB);
    const small = estimateMacModels({ ...hardware, memoryBytes: 8 * GIB });
    expect(small.candidates[0].contextWindow).toBe(4096);
    expect(estimateMacModelCacheBytes(spark, 8192)).toBeLessThan(
      spark.cacheBytes,
    );
    for (const candidate of result.candidates.slice(1))
      expect(candidate.contextWindow).toBeLessThanOrEqual(8192);
    expect(
      estimateMacModels({
        ...hardware,
        memoryBytes: 32 * GIB,
        availableMemoryEstimateBytes: 8 * GIB,
      }).candidates[0].contextWindow,
    ).toBe(40960);
  });
  test.each([
    { platform: 'linux' },
    { arch: 'x64' },
    { release: '23.0.0' },
  ])('does not apply unified-memory estimates to unsupported hardware: %o', (override) => {
    expect(
      estimateMacModels({ ...hardware, ...override, memoryBytes: 128 * GIB })
        .recommended,
    ).toBeNull();
  });
  test('ships only immutable MLX artifacts, without an invented 17B model', () => {
    for (const model of MAC_MODEL_CATALOG)
      expect(model.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(MAC_MODEL_CATALOG.some((model) => model.id.includes('17b'))).toBe(
      false,
    );
  });
  test.each([
    [8, 'spark-x2.5-4b'],
    [16, 'ternary-bonsai-27b'],
    [24, 'qwen3.8-27b'],
    [32, 'nex-n2.5-mini'],
    [64, 'nex-n2.5-mini'],
  ])('chooses a supported shortlist model on an idle %i GiB Mac', (memory, model) => {
    expect(
      estimateMacModels({ ...hardware, memoryBytes: Number(memory) * GIB })
        .recommended,
    ).toBe(model);
  });
  test('keeps unsupported current models visible without recommending them on a large Mac', () => {
    const result = estimateMacModels({ ...hardware, memoryBytes: 512 * GIB });
    expect(LOCAL_MODEL_SHORTLIST).toHaveLength(12);
    expect(result.unavailable.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        'gemma-4-12b',
        'qwen3.8-flash-next',
        'glm-5.3-flash-2bpw',
        'glm-5.3-flash-4bpw',
        'deepseek-v4-flash-vision',
        'glm-5.3-reap-3bpw',
        'nex-n2.5-pro',
        'glm-5.3',
      ]),
    );
    for (const entry of result.unavailable) {
      expect(entry.reason).toBeTruthy();
      expect(
        result.candidates.some((candidate) => candidate.id === entry.id),
      ).toBe(false);
      expect(result.recommended).not.toBe(entry.id);
    }
    expect(
      result.unavailable.find((entry) => entry.id === 'nex-n2.5-pro')
        ?.weightBytes,
    ).toBeNull();
    expect(
      result.candidates.some((entry) =>
        ['qwen3-4b', 'qwen3-8b'].includes(entry.id),
      ),
    ).toBe(false);
  });
  test("does not turn the post's 8 GB Bonsai claim into an 8 GiB Mac recommendation", () => {
    const result = estimateMacModels({ ...hardware, memoryBytes: 8 * GIB });
    const bonsai = result.candidates.find(
      (entry) => entry.id === 'ternary-bonsai-27b',
    )!;
    expect(bonsai.weightBytes).toBeGreaterThan(result.memoryLimitBytes);
    expect(bonsai.fits).toBe(false);
  });
});
test.each([
  'https://example.com/v1',
  'http://192.168.1.1/v1',
  'http://localhost/v1',
  'http://user:secret@127.0.0.1/v1',
  'http://127.0.0.1/v1?target=cloud',
])('rejects non-native MLX endpoint %s', (url) => {
  expect(() => assertMlxEndpoint(url)).toThrow();
});

function relayFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-relay-'));
  directories.push(directory);
  const relay = startMlxRelay({
    ipcPath: directory,
    baseUrl: 'http://127.0.0.1:8321/v1',
    apiKey: 'test-key',
    model: 'test-model',
    task: 'host-task',
  });
  relays.push(relay);
  return { directory, relay };
}
test('sandbox relay preserves streaming, pins destination, and keeps the service key off disk', async () => {
  const fetch = vi.fn(async (_url, init) => {
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(init.headers['X-HybridClaw-Task']).toBe('host-task');
    expect(init.redirect).toBe('error');
    return new Response('data: first\n\ndata: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  const { directory, relay } = relayFixture();
  const response = await fetchMlx(
    'http://mlx.invalid/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'X-HybridClaw-Relay': relay.id },
      body: JSON.stringify({ model: 'test-model', messages: [] }),
    },
    'untrusted-task',
    directory,
  );
  expect(await response.text()).toContain('[DONE]');
  expect(fetch.mock.calls[0][0]).toBe(
    'http://127.0.0.1:8321/v1/chat/completions',
  );
  for (const file of fs.readdirSync(directory))
    expect(fs.readFileSync(path.join(directory, file), 'utf8')).not.toContain(
      'test-key',
    );
});
test('a sandbox worker cannot swap the pinned model', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { directory, relay } = relayFixture();
  const response = await fetchMlx(
    'http://mlx.invalid/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'X-HybridClaw-Relay': relay.id },
      body: JSON.stringify({ model: 'other-model' }),
    },
    undefined,
    directory,
  );
  expect(response.status).toBe(403);
  expect(await response.text()).toContain('not authorized');
  expect(fetch).not.toHaveBeenCalled();
});
test('symlink IPC input cannot read a host file or trigger a request', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const { directory, relay } = relayFixture();
  const external = path.join(directory, 'owner-data');
  fs.writeFileSync(
    external,
    JSON.stringify({ id: 'a'.repeat(32), body: { model: 'test-model' } }),
  );
  fs.symlinkSync(external, path.join(directory, `mlx-${relay.id}.request`));
  await delay(80);
  expect(fetch).not.toHaveBeenCalled();
  expect(fs.readFileSync(external, 'utf8')).toContain('test-model');
});
test('cancelling a sandbox response aborts native generation', async () => {
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      signal = init.signal;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: first\n\n'));
            signal?.addEventListener('abort', () =>
              controller.error(new Error('aborted')),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }),
  );
  const { directory, relay } = relayFixture();
  const response = await fetchMlx(
    'http://mlx.invalid/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'X-HybridClaw-Relay': relay.id },
      body: JSON.stringify({ model: 'test-model' }),
    },
    undefined,
    directory,
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  await vi.waitFor(() => expect(signal?.aborted).toBe(true));
});

test('cancellation before response headers aborts the native relay request', async () => {
  let nativeSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          nativeSignal = init.signal;
          nativeSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    ),
  );
  const { directory, relay } = relayFixture();
  const cancellation = new AbortController();
  const request = fetchMlx(
    'http://mlx.invalid/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'X-HybridClaw-Relay': relay.id },
      signal: cancellation.signal,
      body: JSON.stringify({ model: 'test-model' }),
    },
    undefined,
    directory,
  );
  const rejected = expect(request).rejects.toThrow();
  await vi.waitFor(() => expect(nativeSignal).toBeDefined());
  cancellation.abort();
  await rejected;
  await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
});

test('installation lock refuses a competing live owner and releases cleanly', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-setup-lock-'));
  directories.push(directory);
  const release = claimMlxSetup(directory);
  expect(() => claimMlxSetup(directory)).toThrow('Another local model setup');
  release();
  claimMlxSetup(directory)();
});

test('a busy 32 GiB Mac gets a smaller recommendation without double-counting speculative pages', () => {
  expect(
    parseMacAvailableMemory(
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages inactive: 200.\nPages speculative: 50.',
    ),
  ).toBe(300 * 16384);
  expect(parseMacAvailableMemory('unavailable')).toBeUndefined();
  const result = estimateMacModels({
    ...hardware,
    memoryBytes: 32 * GIB,
    availableMemoryEstimateBytes: 7 * GIB,
  });
  expect(result.recommended).toBe('spark-x2.5-4b');
  expect(result.memoryLimitBytes).toBe(6 * GIB);
});

test('sandbox relay keeps progressing beyond its original deadline', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  }));
  const { directory, relay } = relayFixture();
  const response = await fetchMlx('http://mlx.invalid/v1/chat/completions', {
    method: 'POST', headers: { 'X-HybridClaw-Relay': relay.id },
    body: JSON.stringify({ model: 'test-model' }),
  }, undefined, directory);
  const reader = response.body!.getReader();
  for (let step = 0; step < 5; step++) {
    now += 120_000;
    controller.enqueue(new TextEncoder().encode('data: reasoning\n\n'));
    expect((await reader.read()).done).toBe(false);
    expect(signal.aborted).toBe(false);
  }
  controller.close();
  expect((await reader.read()).done).toBe(true);
});
