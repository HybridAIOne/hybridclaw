import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installMlxModel } from '../src/inference/mlx-install.js';

const mocks = vi.hoisted(() => ({ configure: vi.fn(), secrets: vi.fn(), benchmark: vi.fn(), stop: vi.fn(), home: vi.fn(), spawn: vi.fn(), health: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../src/config/runtime-config.js', () => ({ configureRuntimeLocalEndpoint: mocks.configure, ensureRuntimeConfigFile: vi.fn(), getRuntimeConfig: () => ({ local: { endpoints: [] } }) }));
vi.mock('../src/security/runtime-secrets.js', () => ({ saveNamedRuntimeSecrets: mocks.secrets }));
vi.mock('../src/inference/local-model-catalog.js', async (original) => ({ ...await original<typeof import('../src/inference/local-model-catalog.js')>(), detectMacHardware: () => ({ platform: 'darwin', arch: 'arm64', release: '24', chip: 'Example Mac', memoryBytes: 32 * 1024 ** 3 }) }));
vi.mock('../src/inference/mlx-runtime.js', () => ({ MLX_COMPONENT: '/tmp/example-runtime', mlxHome: mocks.home, mlxHealth: mocks.health, mlxCredentials: () => ({ token: 'test-key', baseUrl: 'http://127.0.0.1:8321/v1' }), startMlxChild: async () => ({ pid: 1 }), stopMlxChild: mocks.stop }));
vi.mock('../src/inference/mlx-benchmark.js', () => ({ benchmarkMlx: mocks.benchmark }));
let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlx-install-'));
  mocks.home.mockReturnValue(dir);
  mocks.health.mockResolvedValue(null);
  mocks.benchmark.mockResolvedValue({ firstTokenMs: 123 });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdin: { end: vi.fn() } });
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
test('activates only after the local tool check and uses console provenance', async () => {
  mocks.benchmark.mockImplementation(async () => { expect(mocks.configure).not.toHaveBeenCalled(); return { firstTokenMs: 123 }; });
  const stages: string[] = [];
  await installMlxModel('spark-x2.5-4b', { quiet: true, route: 'console.local.setup', onProgress: (stage) => stages.push(stage) });
  expect(stages).toEqual(['runtime', 'download', 'loading', 'checking', 'activating']);
  expect(mocks.configure).toHaveBeenCalledWith(expect.objectContaining({ name: 'mac-mlx', zone: 'local' }), expect.anything(), 'mac-mlx/spark-x2.5-4b', { route: 'console.local.setup', source: 'user' });
  expect(mocks.spawn.mock.calls[0][2].stdio).toEqual(['ignore', 'ignore', 'ignore']);
  const profile = JSON.parse(fs.readFileSync(path.join(dir, 'installation.json'), 'utf8'));
  expect(profile.contextWindow).toBe(40960);
  expect(profile).not.toHaveProperty('maxTokens');
  expect(mocks.stop).toHaveBeenCalled();
  expect(fs.existsSync(path.join(dir, 'setup.lock'))).toBe(false);
});
test.each(['failed', 'cancelled'])('restores the previous profile and benchmark when checks are %s', async (outcome) => {
  const previous = { 'installation.json': '{"previous":true}', 'manifest.json': '{}', token: 'old-token', 'benchmark.json': '{"old":true}' };
  for (const [name, contents] of Object.entries(previous)) fs.writeFileSync(path.join(dir, name), contents);
  const controller = new AbortController();
  mocks.benchmark.mockImplementation(async () => {
    if (outcome === 'cancelled') { controller.abort(); return {}; }
    throw new Error('check failed');
  });
  await expect(installMlxModel('spark-x2.5-4b', { signal: controller.signal })).rejects.toThrow();
  for (const [name, contents] of Object.entries(previous)) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(contents);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.secrets).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalled();
  expect(fs.existsSync(path.join(dir, 'setup.lock'))).toBe(false);
});
