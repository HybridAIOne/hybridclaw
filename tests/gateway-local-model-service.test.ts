import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { GatewayLocalModelService } from '../src/gateway/gateway-local-model-service.js';
import { LocalModelMetricsSampler } from '../src/inference/local-model-metrics.js';
import { GIB } from '../src/inference/local-model-catalog.js';

const mocks = vi.hoisted(() => ({ install: vi.fn(), hardware: vi.fn(), home: vi.fn(), health: vi.fn(), read: vi.fn(), start: vi.fn(), stop: vi.fn(), invalidate: vi.fn(), connect: vi.fn(), connected: vi.fn() }));
vi.mock('../src/inference/mlx-connection.js', () => ({ connectMlxModel: mocks.connect, isMlxConnected: mocks.connected }));
vi.mock('../src/inference/mlx-install.js', () => ({ installMlxModel: mocks.install, MlxSetupError: class extends Error {} }));
vi.mock('../src/inference/local-model-catalog.js', async (original) => ({ ...await original<typeof import('../src/inference/local-model-catalog.js')>(), detectMacHardware: mocks.hardware }));
vi.mock('../src/inference/mlx-runtime.js', () => ({ mlxHome: mocks.home, mlxHealth: mocks.health, readMlxInstallation: mocks.read, startMlxChild: mocks.start, stopMlxChild: mocks.stop, mlxCredentials: () => ({ token: 'test-key', baseUrl: 'http://127.0.0.1:8321/v1' }) }));
vi.mock('../src/providers/local-discovery.js', () => ({ invalidateLocalModelDiscovery: mocks.invalidate }));
let dir: string;
let service: GatewayLocalModelService;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockReset();
  mocks.connected.mockReturnValue(false);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-console-'));
  mocks.home.mockReturnValue(dir);
  mocks.hardware.mockReturnValue({ platform: 'darwin', arch: 'arm64', release: '24.0.0', chip: 'Example Mac', memoryBytes: 32 * GIB });
  mocks.health.mockResolvedValue(null);
  mocks.install.mockResolvedValue({});
  service = new GatewayLocalModelService();
});
afterEach(async () => { await service.close(); fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

test.each([null, [], { action: 'shell' }, { action: ['start'] }, { action: 'setup', modelId: '../../tmp/model' }, { action: 'setup', modelId: 'qwen3.8-flash-next' }, { action: 'setup', modelId: 'spark-x2.5-4b', repo: 'example/model' }, { action: 'start', modelId: 'spark-x2.5-4b' }])('rejects unsupported inputs without invoking installation: %j', (body) => {
  expect(() => service.command(body)).toThrow();
  expect(mocks.install).not.toHaveBeenCalled();
});
test('rechecks memory and platform at the command boundary', () => {
  mocks.hardware.mockReturnValue({ platform: 'darwin', arch: 'arm64', release: '24.0.0', chip: 'Example Mac', memoryBytes: 8 * GIB });
  expect(() => service.command({ action: 'setup', modelId: 'qwen3.8-27b' })).toThrow('fits');
  mocks.hardware.mockReturnValue({ platform: 'linux', arch: 'x64', release: '6', chip: 'Example server', memoryBytes: 128 * GIB });
  expect(() => service.command({ action: 'start' })).toThrow('Apple silicon');
});
test('keeps one background job, reports stages, and cancels before admitting another', async () => {
  mocks.install.mockImplementation((_id, { signal, onProgress }) => new Promise((_resolve, reject) => {
    onProgress('download');
    signal.addEventListener('abort', () => reject(new Error('cancelled')));
  }));
  service.command({ action: 'setup', modelId: 'spark-x2.5-4b' });
  expect(() => service.command({ action: 'start' })).toThrow('already running');
  expect((await service.status()).job).toMatchObject({ stage: 'download', status: 'running' });
  service.command({ action: 'cancel' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('cancelled'));
  mocks.install.mockResolvedValue({});
  service.command({ action: 'setup', modelId: 'spark-x2.5-4b' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('completed'));
});
test('does not return subprocess errors or credential-bearing state', async () => {
  mocks.install.mockRejectedValue(new Error('secret-private-payload'));
  service.command({ action: 'setup', modelId: 'spark-x2.5-4b' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('failed'));
  fs.writeFileSync(path.join(dir, 'installation.json'), '{}');
  mocks.read.mockReturnValue({ model: 'spark-x2.5-4b', contextWindow: 4096, secret: 'secret-private-payload' });
  const status = await service.status();
  expect(status.installation).toEqual({ modelId: 'spark-x2.5-4b', contextWindow: 4096 });
  expect(JSON.stringify(status)).not.toContain('secret-private-payload');
});
test('stops its owned model at shutdown and rejects subsequent operations', async () => {
  const child = new EventEmitter() as ChildProcess;
  mocks.start.mockResolvedValue(child);
  service.command({ action: 'start' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('completed'));
  await service.close();
  expect(mocks.stop).toHaveBeenCalledWith(child);
  expect(() => service.command({ action: 'start' })).toThrow('shutting down');
});
test('uses only the authenticated loopback stop endpoint', async () => {
  const request = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', request);
  service.command({ action: 'stop' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('completed'));
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:8321/control/stop', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer test-key' }, redirect: 'error' }));
});


test('invalidates discovery after background startup and unexpected model exit', async () => {
  const child = new EventEmitter() as ChildProcess;
  let ready!: (child: ChildProcess) => void;
  mocks.start.mockImplementation(() => new Promise<ChildProcess>((resolve) => { ready = resolve; }));
  service.command({ action: 'start' });
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
  mocks.invalidate.mockClear();
  ready(child);
  await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
  mocks.invalidate.mockClear();
  child.emit('exit', 1);
  expect(mocks.invalidate).toHaveBeenCalledOnce();
});

test('invalidates discovery when observed health changes outside a console job', async () => {
  fs.writeFileSync(path.join(dir, 'installation.json'), '{}');
  mocks.read.mockReturnValue({ model: 'spark-x2.5-4b', contextWindow: 40960 });
  await service.status();
  mocks.invalidate.mockClear();
  mocks.health.mockResolvedValue({ status: 'ready' });
  expect((await service.status()).running).toBe(true);
  expect(mocks.invalidate).toHaveBeenCalledOnce();
  await service.status();
  expect(mocks.invalidate).toHaveBeenCalledOnce();
  mocks.health.mockResolvedValue(null);
  expect((await service.status()).running).toBe(false);
  expect(mocks.invalidate).toHaveBeenCalledTimes(2);
});

test('invalidates discovery after a failed lifecycle operation without exposing its error', async () => {
  mocks.start.mockRejectedValue(new Error('secret-private-payload'));
  service.command({ action: 'start' });
  await vi.waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
  const result = await service.status();
  expect(result.job?.status).toBe('failed');
  expect(JSON.stringify(result)).not.toContain('secret-private-payload');
});


test('returns allowlisted activity metrics without exposing native health payloads', async () => {
  fs.writeFileSync(path.join(dir, 'installation.json'), '{}');
  mocks.read.mockReturnValue({ model: 'spark-x2.5-4b', contextWindow: 40960 });
  mocks.health.mockResolvedValue({ metrics: { instanceId: 'a'.repeat(32), generatedTokens: 123, prompt: 'private-payload' }, credentials: 'private-payload' });
  service.startMetrics();
  await vi.waitFor(async () => expect((await service.status()).metricsHistory).toHaveLength(1));
  const result = await service.status();
  expect(result.metricsHistory[0]).toMatchObject({ generatedTokens: 123, tokensPerSecond: null, runtimeId: 'a'.repeat(32) });
  expect(JSON.stringify(result)).not.toContain('private-payload');
});


test('status distinguishes an unregistered healthy worker without repairing it', async () => {
  fs.writeFileSync(path.join(dir, 'installation.json'), '{}');
  mocks.read.mockReturnValue({ model: 'spark-x2.5-4b', contextWindow: 40960 });
  mocks.health.mockResolvedValue({ status: 'ready' });
  expect(await service.status()).toMatchObject({ running: true, connected: false });
  expect(mocks.connect).not.toHaveBeenCalled();
  mocks.invalidate.mockClear();
  mocks.connected.mockReturnValue(true);
  expect(await service.status()).toMatchObject({ running: true, connected: true });
  expect(mocks.invalidate).toHaveBeenCalledOnce();
});

test('start reconnects an already healthy worker without spawning or taking ownership', async () => {
  mocks.health.mockResolvedValue({ status: 'ready' });
  service.command({ action: 'start' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('completed'));
  expect(mocks.connect).toHaveBeenCalledWith({ route: 'console.local.start' });
  expect(mocks.start).not.toHaveBeenCalled();
  await service.close();
  expect(mocks.stop).not.toHaveBeenCalled();
});

test.each([true, false])('connection failure cleans up only a worker started by the job (already running: %s)', async (running) => {
  const child = new EventEmitter() as ChildProcess;
  mocks.health.mockResolvedValue(running ? { status: 'ready' } : null);
  mocks.start.mockResolvedValue(child);
  mocks.connect.mockImplementation(() => { throw new Error('private-credential-payload'); });
  service.command({ action: 'start' });
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('failed'));
  const result = await service.status();
  expect(result.job).toMatchObject({ stage: 'connecting', error: expect.stringContaining('could not connect to chat') });
  expect(JSON.stringify(result)).not.toContain('private-credential-payload');
  if (running) expect(mocks.stop).not.toHaveBeenCalled();
  else expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);
});

test('cancellation during startup unloads the new worker without registering it', async () => {
  const child = new EventEmitter() as ChildProcess;
  let ready!: (child: ChildProcess) => void;
  mocks.start.mockImplementation(() => new Promise<ChildProcess>((resolve) => { ready = resolve; }));
  service.command({ action: 'start' });
  await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled());
  service.command({ action: 'cancel' });
  ready(child);
  await vi.waitFor(async () => expect((await service.status()).job?.status).toBe('cancelled'));
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);
});


test('collects on the gateway cadence without status requests and drains at shutdown', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  const sample = vi.spyOn(LocalModelMetricsSampler.prototype, 'sample').mockImplementation(async () => ({
    sampledAt: Date.now(), cpuPercent: 25, memoryUsedBytes: 16 * GIB, memoryTotalBytes: 32 * GIB,
    gpuPercent: 40, tokensPerSecond: 0, generatedTokens: 0, runtimeId: null,
  }));
  service.startMetrics();
  service.startMetrics();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sample).toHaveBeenCalledTimes(6);
  expect(mocks.health).toHaveBeenCalledTimes(6);
  const result = await service.status();
  expect(result.metricsHistory).toHaveLength(6);
  expect((await service.status()).metricsHistory).toEqual(result.metricsHistory);
  expect(sample).toHaveBeenCalledTimes(6);
  expect(mocks.connect).not.toHaveBeenCalled();
  await service.close();
  service.startMetrics();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sample).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(0);
});

test.each([
  { platform: 'linux', arch: 'arm64', release: '6' },
  { platform: 'darwin', arch: 'x64', release: '24' },
  { platform: 'darwin', arch: 'arm64', release: '23' },
])('does not start background collection on unsupported hardware: %j', async (hardware) => {
  vi.useFakeTimers();
  mocks.hardware.mockReturnValue({ ...hardware, chip: 'Example host', memoryBytes: 32 * GIB });
  service.startMetrics();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.health).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect((await service.status()).metricsHistory).toEqual([]);
});

test('keeps collecting host activity when the installation cannot supply health', async () => {
  mocks.health.mockRejectedValue(new Error('private-credential-payload'));
  const sample = vi.spyOn(LocalModelMetricsSampler.prototype, 'sample').mockResolvedValue({
    sampledAt: Date.now(), cpuPercent: 25, memoryUsedBytes: 16 * GIB, memoryTotalBytes: 32 * GIB,
    gpuPercent: 40, tokensPerSecond: 0, generatedTokens: 0, runtimeId: null,
  });
  service.startMetrics();
  await vi.waitFor(() => expect(sample).toHaveBeenCalled());
  expect(sample).toHaveBeenCalledWith(expect.objectContaining({ arch: 'arm64' }), null);
  expect(JSON.stringify(await service.status())).not.toContain('private-credential-payload');
});
