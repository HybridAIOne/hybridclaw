import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { BenchmarkResources, DEFAULT_BENCHMARK_BUDGET } from '../eval-harness/src/benchmark-resources.js';
import { runTerminalBenchNativeCli } from '../eval-harness/src/terminal-bench-native.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({ command: vi.fn(), handle: vi.fn() }));
vi.mock('../eval-harness/src/benchmark-command.js', () => ({ benchmarkCommand: mocks.command }));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({ handleGatewayMessage: mocks.handle }));
vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution: vi.fn() }));
const temp = useTempDir('benchmark-task-cleanup-');
const guards: BenchmarkResources[] = [];
let root: string;
let engine: string;
let stubborn: boolean;
let queryFails: boolean;
let startupFails: boolean;
const live = new Set<string>();
const removals: Array<{ engine: string; name: string }> = [];
const metrics = 'MemAvailable: 33554432 kB\nSwapTotal: 16777216 kB\nSwapFree: 16777216 kB\noverlay 314572800 0 209715200 0% /';
useCleanMocks({ cleanup: async () => {
  engine = 'engine-a'; stubborn = false; queryFails = false;
  for (const guard of guards.splice(0)) await guard.close();
  live.clear();
  vi.restoreAllMocks();
} });
beforeEach(() => {
  root = temp(); engine = 'engine-a'; stubborn = false; queryFails = false; startupFails = false;
  removals.length = 0; live.clear();
  vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  vi.spyOn(os, 'platform').mockReturnValue('darwin');
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 200 * 1024 ** 3, bsize: 1 } as fs.StatsFs);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const start = BenchmarkResources.prototype.start;
  vi.spyOn(BenchmarkResources.prototype, 'start').mockImplementation(function(this: BenchmarkResources, ...args) {
    guards.push(this); return start.apply(this, args);
  });
  mocks.handle.mockReset().mockResolvedValue({ status: 'success' });
  mocks.command.mockReset().mockImplementation(async ({ command, args }: { command: string; args: string[] }) => {
    let stdout = ''; let status = 0;
    if (command === '/usr/bin/vm_stat') stdout = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 2097152.\nPages inactive: 2097152.';
    else if (command === '/usr/sbin/sysctl') stdout = args[0] === '-n' ? '1\n' : 'vm.swapusage: total = 1024.00M used = 0.00M free = 1024.00M';
    else if (command !== 'docker') stdout = JSON.stringify([{ task_name: 'example', instruction: 'Create an example artifact.', docker_image: 'example/task:latest' }]);
    else if (args[0] === 'info') stdout = args.at(-1) === '{{json .}}' ? JSON.stringify({ ID: engine, MemoryLimit: true, SwapLimit: true }) : engine;
    else if (args[0] === 'run') {
      const name = args[args.indexOf('--name') + 1]; live.add(name); stdout = name;
      if (startupFails && name.startsWith('hybridclaw-tb2-')) throw new Error('Fixture task startup failed');
    } else if (args[0] === 'exec' && args[1]?.startsWith('hybridclaw-benchmark-probe-')) stdout = metrics;
    else if (args[0] === 'rm') {
      const name = args[2]; removals.push({ engine, name });
      if (stubborn && name.startsWith('hybridclaw-tb2-')) status = 1;
      else if (engine === 'engine-a') live.delete(name);
    } else if (args[0] === 'ps') {
      const name = args[args.indexOf('--filter') + 1].slice('name=^/'.length, -1);
      if (queryFails && name.startsWith('hybridclaw-tb2-')) status = 1;
      else stdout = live.has(name) ? name + '\n' : '';
    }
    return { status, stdout, stderr: '' };
  });
});
function run() { return runTerminalBenchNativeCli(['--install-dir', root, '--data-dir', root, '--model', 'example-model']); }
function result() {
  const job = fs.readdirSync(path.join(root, 'jobs'))[0];
  return JSON.parse(fs.readFileSync(path.join(root, 'jobs', job, 'result.json'), 'utf8'));
}
function locks() { return fs.readdirSync(root).filter(name => name.endsWith('.lock')); }

test('refuses task removal after the Docker engine changes', async () => {
  mocks.handle.mockImplementationOnce(async () => { engine = 'engine-b'; return { status: 'success' }; });
  await expect(run()).rejects.toThrow(/engine changed|cleanup/i);
  expect(removals.filter(x => x.engine === 'engine-b')).toEqual([]);
  expect(locks()).toHaveLength(1);
  expect(result().mean).toBeNull();
});

test.each(['still-running', 'unknown-state'] as const)('retains the engine lock while task cleanup is %s', async reason => {
  stubborn = reason === 'still-running'; queryFails = reason === 'unknown-state';
  await expect(run()).rejects.toThrow(/cleanup/i);
  expect(locks()).toHaveLength(1);
  expect(result()).toMatchObject({ mean: null, trials: 1, errors: 1 });
  expect(result().infrastructureError).toMatch(/cleanup/i);
});

test.each(['agent', 'startup'] as const)('preserves the original %s failure when its cleanup also fails', async (phase) => {
  stubborn = true;
  startupFails = phase === 'startup';
  mocks.handle.mockRejectedValueOnce(new Error('Fixture agent execution failed'));
  await expect(run()).rejects.toThrow(/cleanup/i);
  expect(result().rewards[0].error).toMatch(phase === 'startup' ? /Fixture task startup failed/ : /Fixture agent execution failed/);
  expect(result().rewards[0].error).toMatch(/cleanup/i);
});

test.each([false, true])('coalesces abort and final cleanup, including removal failure: %s', async fails => {
  stubborn = fails;
  mocks.handle.mockImplementationOnce(async () => { guards[0].abort(new Error('Fixture resource stop')); return { status: 'success' }; });
  await expect(run()).rejects.toThrow(/Fixture resource stop|cleanup/i);
  const taskRemovals = removals.filter(x => x.name.startsWith('hybridclaw-tb2-'));
  expect(taskRemovals).toHaveLength(fails ? 2 : 1);
  expect(result().mean).toBeNull();
});

test('cleans up a task that started before its startup command failed', async () => {
  startupFails = true;
  await run();
  expect(mocks.handle).not.toHaveBeenCalled();
  expect(result().rewards[0].error).toMatch(/Fixture task startup failed/);
  expect(live.size).toBe(0);
  expect(locks()).toHaveLength(0);
});

test('a completed task confirms removal before releasing admission', async () => {
  await run();
  expect(result()).toMatchObject({ trials: 1, errors: 0, mean: 1 });
  const taskName = removals.find(x => x.name.startsWith('hybridclaw-tb2-'))?.name;
  expect(mocks.command.mock.calls.some(([params]) => params.args[0] === 'ps' && params.args.includes(`name=^/${taskName}$`))).toBe(true);
  expect(live.size).toBe(0);
  expect(locks()).toHaveLength(0);
});

test('refuses unregistered container removal without a Docker command', async () => {
  const resources = new BenchmarkResources([root], DEFAULT_BENCHMARK_BUDGET, () => {});
  expect(() => resources.registerContainer('example-task')).toThrow(/admission/);
  await resources.start(1, 1);
  const before = mocks.command.mock.calls.length;
  await expect(resources.removeContainer('unowned')).rejects.toThrow(/unowned/);
  expect(mocks.command).toHaveBeenCalledTimes(before);
});
