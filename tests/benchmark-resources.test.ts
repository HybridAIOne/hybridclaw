import fs from 'node:fs';
import os from 'node:os';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  assertBenchmarkCapacity,
  BenchmarkResources,
  DEFAULT_BENCHMARK_BUDGET,
  parseEngineResources,
  parseMacMemoryPressure,
  type BenchmarkSnapshot,
} from '../eval-harness/src/benchmark-resources.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../eval-harness/src/benchmark-command.js', () => ({ benchmarkCommand: mocks.command }));
const GIB = 1024 ** 3;
const budget = DEFAULT_BENCHMARK_BUDGET;
const healthy: BenchmarkSnapshot = {
  hostMemoryAvailable: 64 * GIB, hostSwapUsed: 0, hostMemoryPressureLevel: 1, hostDiskFree: 200 * GIB,
  engineMemoryAvailable: 32 * GIB, engineSwapFree: 16 * GIB,
  engineSwapUsed: 0, engineDiskFree: 200 * GIB,
};
const engineOutput = (available = 32 * GIB) => [
  `MemAvailable: ${available / 1024} kB`,
  `SwapTotal: ${16 * GIB / 1024} kB`,
  `SwapFree: ${16 * GIB / 1024} kB`,
  'Filesystem 1024-blocks Used Available Capacity Mounted on',
  `overlay ${300 * GIB / 1024} 0 ${200 * GIB / 1024} 0% /`,
].join('\n');
const tempDir = useTempDir();
const guards: BenchmarkResources[] = [];
useCleanMocks({ cleanup: async () => {
  for (const guard of guards.splice(0)) await guard.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
} });
let root: string;
let diskFree: number;
let engine: string;
beforeEach(() => {
  mocks.command.mockReset();
  root = tempDir();
  diskFree = healthy.hostDiskFree;
  engine = engineOutput();
  vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  vi.spyOn(os, 'platform').mockReturnValue('darwin');
  vi.spyOn(fs, 'statfsSync').mockImplementation(() => ({ bavail: diskFree, bsize: 1 }) as fs.StatsFs);
  mocks.command.mockImplementation(async ({ command, args }: { command: string; args: string[] }) => {
    let stdout = '';
    if (command === '/usr/bin/vm_stat') stdout = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2097152.\nPages inactive: 2097152.';
    else if (command === '/usr/sbin/sysctl' && args[0] === '-n') stdout = '1\n';
    else if (command === '/usr/sbin/sysctl') stdout = 'vm.swapusage: total = 1024.00M used = 0.00M free = 1024.00M';
    else if (args[0] === 'info') stdout = args.at(-1) === '{{json .}}' ? JSON.stringify({ ID: 'test-engine', MemoryLimit: true, SwapLimit: true }) : 'test-engine\n';
    else if (args[0] === 'exec') stdout = engine;
    return { status: 0, stdout, stderr: '' };
  });
});
function guard() {
  const record = vi.fn();
  const resources = new BenchmarkResources([root], budget, record);
  guards.push(resources);
  return { resources, record };
}

test.each([
  ['hostMemoryAvailable', 7 * GIB], ['engineMemoryAvailable', 5 * GIB],
  ['hostDiskFree', 30 * GIB], ['engineDiskFree', 30 * GIB],
  ['engineSwapFree', GIB], ['engineSwapUsed', 3 * GIB],
])('refuses concurrent demand or existing pressure for %s', (metric, value) => {
  expect(() => assertBenchmarkCapacity({ ...healthy, [metric]: value }, budget, 2, 2)).toThrow(/admission refused/);
});

test('retained macOS swap does not veto normal pressure with sufficient headroom', () => {
  expect(() => assertBenchmarkCapacity({ ...healthy, hostSwapUsed: 24 * GIB }, budget, 1, 1)).not.toThrow();
  expect(() => assertBenchmarkCapacity({ ...healthy, hostSwapUsed: 24 * GIB, hostMemoryAvailable: GIB }, budget, 1, 1)).toThrow(/hostMemoryAvailable/);
  expect(() => assertBenchmarkCapacity({ ...healthy, hostSwapUsed: 24 * GIB, engineSwapUsed: 3 * GIB }, budget, 1, 1)).toThrow(/swap pressure/);
});

test.each([2, 4])('refuses active macOS pressure level %s even with little swap used', (hostMemoryPressureLevel) => {
  expect(() => assertBenchmarkCapacity({ ...healthy, hostMemoryPressureLevel }, budget, 1, 1)).toThrow(/elevated memory pressure/);
});

test('retains the swap threshold on hosts without a kernel pressure signal', () => {
  const snapshot = { ...healthy, hostSwapUsed: 3 * GIB };
  delete snapshot.hostMemoryPressureLevel;
  expect(() => assertBenchmarkCapacity(snapshot, budget, 1, 1)).toThrow(/swap pressure/);
});

test.each(['', '0', '3', '5', 'NaN', 'warning', '1 extra'])('refuses missing or unknown macOS pressure: %j', (value) => {
  expect(() => parseMacMemoryPressure(value)).toThrow(/metric/);
});
test.each([1, 2, 4])('parses kernel pressure level %s', (level) => {
  expect(parseMacMemoryPressure(`${level}\n`)).toBe(level);
});

test.each(['2\n', '4\n', '', '9\n'])('refuses bad macOS pressure before Docker creation: %j', async (pressure) => {
  const original = mocks.command.getMockImplementation()!;
  mocks.command.mockImplementation(async (params) => params.command === '/usr/sbin/sysctl' && params.args[0] === '-n'
    ? {status: 0, stdout: pressure, stderr: ''} : original(params));
  await expect(guard().resources.start(1, 1)).rejects.toThrow(/pressure/);
  expect(mocks.command.mock.calls.some(([params]) => params.command === 'docker')).toBe(false);
});

test('budgets cumulative images, build/extraction data, artifacts and concurrent swap', () => {
  // Ten tasks retain 90 GiB, even with only one task running at a time.
  expect(() => assertBenchmarkCapacity({ ...healthy, hostDiskFree: 100 * GIB }, budget, 1, 10)).toThrow(/hostDiskFree/);
  expect(() => assertBenchmarkCapacity({ ...healthy, hostDiskFree: 111 * GIB }, budget, 1, 10)).not.toThrow();
  expect(() => assertBenchmarkCapacity({ ...healthy, hostDiskFree: 111 * GIB }, budget, 2, 10)).toThrow(/hostDiskFree/);
});

test('enforces floors while monitoring without charging already consumed reservations again', () => {
  expect(() => assertBenchmarkCapacity({ ...healthy, hostDiskFree: 20 * GIB, engineMemoryAvailable: 2 * GIB, engineSwapFree: 0 }, budget, 0, 0)).not.toThrow();
  expect(() => assertBenchmarkCapacity({ ...healthy, hostDiskFree: 20 * GIB - 1 }, budget, 0, 0)).toThrow();
});

test.each([NaN, Infinity, -1])('refuses unknown/invalid telemetry: %s', (value) => {
  expect(() => assertBenchmarkCapacity({ ...healthy, engineDiskFree: value }, budget, 0, 0)).toThrow(/metric/);
});

test('parses engine memory, swap and storage rather than host-only totals', () => {
  expect(parseEngineResources(engineOutput())).toEqual({
    engineMemoryAvailable: healthy.engineMemoryAvailable,
    engineSwapFree: healthy.engineSwapFree, engineSwapUsed: 0, engineDiskFree: healthy.engineDiskFree,
  });
});
test.each(['', engineOutput().replace('MemAvailable:', 'Unknown:'), engineOutput().replace(/overlay .*/, 'invalid')])('fails closed on incomplete engine telemetry', (output) => {
  expect(() => parseEngineResources(output)).toThrow();
});

test('refuses low host disk before creating any Docker resources', async () => {
  diskFree = 5 * GIB;
  await expect(guard().resources.start(1, 1)).rejects.toThrow(/hostDiskFree/);
  expect(mocks.command.mock.calls.some(([params]) => params.command === 'docker')).toBe(false);
});

test('serializes runs per engine and releases only its own probe and lock', async () => {
  const first = guard();
  const second = guard();
  await first.resources.start(2, 2);
  expect(first.record).toHaveBeenCalledWith(healthy);
  await expect(second.resources.start(1, 1)).rejects.toThrow(/Another benchmark/);
  await second.resources.close();
  expect(fs.readdirSync(root).filter((name) => name.endsWith('.lock'))).toHaveLength(1);
  await first.resources.close();
  expect(fs.readdirSync(root)).toEqual([]);
  const dockerCalls = mocks.command.mock.calls.map(([params]) => params).filter((params) => params.command === 'docker');
  expect(dockerCalls.find((params) => params.args[0] === 'run')?.args).toEqual(expect.arrayContaining(['--pull=never', '--read-only', '--network=none', '--memory=32m', '--memory-swap=32m']));
  const removals = dockerCalls.filter((params) => params.args[0] === 'rm');
  expect(removals).toHaveLength(1);
  expect(removals[0].args[2]).toMatch(/^hybridclaw-benchmark-probe-/);
  expect(dockerCalls.some((params) => params.args.includes('prune'))).toBe(false);
});

test('cleans up a failed preflight and keeps a missing probe from triggering a pull', async () => {
  const original = mocks.command.getMockImplementation()!;
  mocks.command.mockImplementation(async (params) => {
    if (params.args[0] === 'image') throw new Error('missing image');
    return original(params);
  });
  await expect(guard().resources.start(1, 1)).rejects.toThrow(/docker pull busybox:1.37/);
  expect(fs.readdirSync(root)).toEqual([]);
  expect(mocks.command.mock.calls.some(([params]) => ['run', 'pull'].includes(params.args[0]))).toBe(false);
});

test.each(['disk', 'memory', 'engine', 'telemetry', 'pressure'])('aborts active work when periodic %s checks fail', async (failure) => {
  vi.useFakeTimers();
  const { resources, record } = guard();
  await resources.start(1, 1);
  const stopped = vi.fn();
  resources.signal.addEventListener('abort', stopped);
  if (failure === 'disk') diskFree = 19 * GIB;
  if (failure === 'memory') engine = engineOutput(GIB);
  if (failure === 'telemetry') engine = '';
  if (failure === 'engine') mocks.command.mockRejectedValue(new Error('engine unavailable'));
  if (failure === 'pressure') {
    const original = mocks.command.getMockImplementation()!;
    mocks.command.mockImplementation(async (params) => params.command === '/usr/sbin/sysctl' && params.args[0] === '-n'
      ? {status: 0, stdout: '2\n', stderr: ''} : original(params));
  }
  await vi.advanceTimersByTimeAsync(5000);
  expect(resources.signal.aborted).toBe(true);
  expect(stopped).toHaveBeenCalledOnce();
  expect(record).toHaveBeenCalled();
  await expect(resources.check(1, 1)).rejects.toThrow(/infrastructure stopped/);
  // Restore command execution so teardown can remove the owned probe.
  mocks.command.mockResolvedValue({ status: 0, stdout: '', stderr: '' });
});

test('serializes simultaneous dispatch checks rather than racing their probes', async () => {
  const { resources } = guard();
  await resources.start(1, 1);
  const original = mocks.command.getMockImplementation()!;
  let active = 0;
  let peak = 0;
  mocks.command.mockImplementation(async (params) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    const result = await original(params);
    active -= 1;
    return result;
  });
  await Promise.all([resources.check(1, 1), resources.check(1, 1), resources.check(1, 1)]);
  expect(peak).toBe(1);
});
