import os from 'node:os';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LocalModelMetricsSampler, parseMacGpuPercent } from '../src/inference/local-model-metrics.js';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }), execFileSync: vi.fn() };
});
const hardware = { platform: 'darwin', arch: 'arm64', release: '24', chip: 'Example Mac', memoryBytes: 32 * 1024 ** 3, availableMemoryEstimateBytes: 8 * 1024 ** 3 };
const health = (generatedTokens: unknown, instanceId = 'a'.repeat(32)) => ({ metrics: { instanceId, generatedTokens, prompt: 'private-payload' }, secret: 'private-payload' });
let clock = 1000;
let user = 100;
let idle = 300;
beforeEach(() => {
  vi.clearAllMocks();
  clock = 1000; user = 100; idle = 300;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(os, 'cpus').mockImplementation(() => [{ model: 'Example Mac', speed: 0, times: { user, idle, nice: 0, sys: 0, irq: 0 } }]);
  mocks.exec.mockImplementation(async (command: string) => ({ stdout: command === '/usr/bin/vm_stat'
    ? 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 262144.\nPages inactive: 262144.'
    : '"PerformanceStatistics" = {"Device Utilization %"=63}' }));
});
afterEach(() => vi.restoreAllMocks());

test.each([
  ['"PerformanceStatistics" = {"Device Utilization %"=0}', 0],
  ['"PerformanceStatistics" = {"Device Utilization %"=62.5,"Renderer Utilization %"=90}', 62.5],
  ['"PerformanceStatistics" = {"Device Utilization %"=100}', 100],
  ['"Device Utilization %"=50', null],
  ['"PerformanceStatistics" = {"Renderer Utilization %"=90}', null],
  ['"PerformanceStatistics" = {"Device Utilization %"=-1}', null],
  ['"PerformanceStatistics" = {"Device Utilization %"=101}', null],
  ['"PerformanceStatistics" = {"Device Utilization %"="private-payload"}', null],
])('parses bounded macOS device utilization: %s', (output, expected) => {
  expect(parseMacGpuPercent(output)).toBe(expected);
});

test('measures CPU and generated token deltas, distinguishes warmup, and excludes payloads', async () => {
  const sampler = new LocalModelMetricsSampler();
  const first = await sampler.sample(hardware, health(10));
  expect(first).toMatchObject({ cpuPercent: null, tokensPerSecond: null, generatedTokens: 10, gpuPercent: 63, memoryUsedBytes: 24 * 1024 ** 3 });
  clock += 2500; user += 75; idle += 25;
  const next = await sampler.sample(hardware, health(60));
  expect(next.cpuPercent).toBe(75);
  expect(next.tokensPerSecond).toBe(20);
  expect(JSON.stringify(next)).not.toContain('private-payload');
  expect(mocks.exec).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-r', '-c', 'IOAccelerator', '-d', '1'], { encoding: 'utf8', timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
  clock += 2500; idle += 100;
  expect(await sampler.sample(hardware, health(60))).toMatchObject({ cpuPercent: 0, tokensPerSecond: 0 });
});

test('does not carry token rates across runtime restarts, counter resets or sampling gaps', async () => {
  const sampler = new LocalModelMetricsSampler();
  await sampler.sample(hardware, health(100));
  clock += 2500;
  expect((await sampler.sample(hardware, health(200, 'b'.repeat(32)))).tokensPerSecond).toBeNull();
  clock += 2500;
  expect((await sampler.sample(hardware, health(10, 'b'.repeat(32)))).tokensPerSecond).toBeNull();
  clock += 60_000; user += 100;
  expect(await sampler.sample(hardware, health(100, 'b'.repeat(32)))).toMatchObject({ cpuPercent: null, tokensPerSecond: null });
  expect(await sampler.sample(hardware, null)).toMatchObject({ generatedTokens: 0, tokensPerSecond: 0, runtimeId: null });
});

test.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '10', null])('rejects invalid runtime counters: %s', async (count) => {
  expect(await new LocalModelMetricsSampler().sample(hardware, health(count))).toMatchObject({ generatedTokens: null, tokensPerSecond: null, runtimeId: null });
});

test('missing counters, unavailable GPU and invalid memory never look like zero utilization', async () => {
  mocks.exec.mockRejectedValue(new Error('private-payload'));
  const sample = await new LocalModelMetricsSampler().sample({ ...hardware, availableMemoryEstimateBytes: -1 }, { metrics: { instanceId: 'private-payload', generatedTokens: 10 } });
  expect(sample).toMatchObject({ gpuPercent: null, memoryUsedBytes: null, generatedTokens: null, tokensPerSecond: null });
  expect(JSON.stringify(sample)).not.toContain('private-payload');
});

test('does not invoke macOS commands on unsupported hosts', async () => {
  expect((await new LocalModelMetricsSampler().sample({ ...hardware, platform: 'linux' }, null)).gpuPercent).toBeNull();
  expect(mocks.exec).not.toHaveBeenCalled();
});

test('coalesces simultaneous probes without skipping the next one-second tick', async () => {
  const sampler = new LocalModelMetricsSampler();
  let finish!: (value: { stdout: string }) => void;
  mocks.exec.mockImplementation((command: string) => command === '/usr/bin/vm_stat' ? Promise.resolve({ stdout: '' }) : new Promise((resolve) => { finish = resolve; }));
  const first = sampler.sample(hardware, health(10));
  const second = sampler.sample(hardware, health(10));
  expect(first).toBe(second);
  finish({ stdout: '' });
  await first;
  expect(mocks.exec).toHaveBeenCalledTimes(2);
  // A nominal one-second tick can arrive slightly early after timer jitter.
  clock += 980; user += 75; idle += 25;
  const next = sampler.sample(hardware, health(59));
  finish({ stdout: '' });
  expect(await next).toMatchObject({ cpuPercent: 75, tokensPerSecond: 50 });
  expect(mocks.exec).toHaveBeenCalledTimes(4);
});


test('samples memory afresh and keeps GPU data when the memory probe fails', async () => {
  const sampler = new LocalModelMetricsSampler();
  expect((await sampler.sample(hardware, null)).memoryUsedBytes).toBe(24 * 1024 ** 3);
  mocks.exec.mockImplementation(async (command: string) => {
    if (command === '/usr/bin/vm_stat') throw new Error('private-payload');
    return { stdout: '"PerformanceStatistics" = {"Device Utilization %"=45}' };
  });
  clock += 1000;
  expect(await sampler.sample(hardware, null)).toMatchObject({ memoryUsedBytes: null, gpuPercent: 45 });
  expect(mocks.exec).toHaveBeenCalledWith('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1000, maxBuffer: 64 * 1024 });
});
