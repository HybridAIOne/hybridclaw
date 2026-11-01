import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { runTerminalBenchNativeCli } from '../eval-harness/src/terminal-bench-native.js';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({
  command: vi.fn(), start: vi.fn(), check: vi.fn(), close: vi.fn(),
  handle: vi.fn(), stop: vi.fn(), controller: new AbortController(),
  budget: { memoryGiB: 2, swapGiB: 1, diskGiB: 8, artifactGiB: 1 },
}));
vi.mock('../src/agent/executor.js', () => ({ stopSessionExecution: mocks.stop }));
vi.mock('../src/gateway/gateway-chat-service.js', () => ({ handleGatewayMessage: mocks.handle }));
vi.mock('../eval-harness/src/benchmark-command.js', () => ({ benchmarkCommand: mocks.command }));
vi.mock('../eval-harness/src/benchmark-resources.js', () => ({
  DEFAULT_BENCHMARK_BUDGET: mocks.budget,
  BenchmarkResources: class {
    signal = mocks.controller.signal;
    budget: typeof mocks.budget;
    start = mocks.start;
    check = mocks.check;
    close = mocks.close;
    abort = (reason: Error) => mocks.controller.abort(reason);
    constructor(_paths: string[], budget: typeof mocks.budget) { this.budget = budget; }
  },
}));
const tempDir = useTempDir();
useCleanMocks({ restoreAllMocks: true });
let root: string;
let tasks: Array<{ task_name: string; instruction: string; docker_image: string }>;
beforeEach(() => {
  vi.clearAllMocks();
  root = tempDir();
  mocks.controller = new AbortController();
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.check.mockReset().mockResolvedValue(undefined);
  mocks.close.mockReset().mockResolvedValue(undefined);
  mocks.handle.mockReset().mockResolvedValue({ status: 'success' });
  tasks = [1, 2, 3].map((index) => ({ task_name: `task_${index}`, instruction: 'Create an example artifact.', docker_image: 'example/task:latest' }));
  mocks.command.mockReset().mockImplementation(async ({ command }: { command: string }) => ({
    status: 0, stdout: command === 'docker' ? '' : JSON.stringify(tasks), stderr: '',
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
const args = () => ['--install-dir', root, '--data-dir', root, '--model', 'example-model', '--num-tasks', '3'];
function result() {
  const job = fs.readdirSync(path.join(root, 'jobs'))[0];
  return JSON.parse(fs.readFileSync(path.join(root, 'jobs', job, 'result.json'), 'utf8'));
}

test('preflight refusal launches no tasks, dataset downloads or builds', async () => {
  mocks.start.mockRejectedValue(new Error('resource admission refused'));
  await expect(runTerminalBenchNativeCli(args())).rejects.toThrow(/admission refused/);
  expect(mocks.command).not.toHaveBeenCalled();
  expect(mocks.handle).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledOnce();
});

test('fails closed on unknown resource options instead of silently using defaults', async () => {
  await expect(runTerminalBenchNativeCli([...args(), '--task-disk-gibb=20'])).rejects.toThrow(/Unknown/);
  expect(mocks.start).not.toHaveBeenCalled();
});

test('accounts explicit concurrency and supplies memory plus swap limits to each task', async () => {
  await runTerminalBenchNativeCli([...args(), '--n-concurrent=2', '--task-memory-gib', '3', '--task-swap-gib=0.5']);
  expect(mocks.start).toHaveBeenCalledWith(2, 3);
  const runs = mocks.command.mock.calls.map(([params]) => params).filter((params) => params.args[0] === 'run');
  expect(runs).toHaveLength(3);
  for (const run of runs) {
    expect(run.args).toEqual(expect.arrayContaining(['--memory', String(3 * 1024 ** 3), '--memory-swap', String(3.5 * 1024 ** 3)]));
    expect(run.signal).toBe(mocks.controller.signal);
  }
  expect(result()).toMatchObject({ trials: 3, errors: 0, mean: 1 });
  expect(mocks.close).toHaveBeenCalledOnce();
});

test.each(['--n-concurrent=0', '--n-concurrent=NaN', '--task-disk-gib=-1', '--task-memory-gib=0', '--task-memory-gib=Infinity', '--num-tasks=oops'])('rejects invalid admission inputs before work: %s', async (arg) => {
  await expect(runTerminalBenchNativeCli([...args(), arg])).rejects.toThrow(/Invalid/);
  expect(mocks.start).not.toHaveBeenCalled();
});

test('records infrastructure failure and stops queue admission and owned executions', async () => {
  mocks.handle.mockImplementationOnce(async () => {
    mocks.controller.abort(new Error('engine disk pressure'));
    return { status: 'success' };
  });
  await expect(runTerminalBenchNativeCli(args())).rejects.toThrow(/engine disk pressure/);
  expect(mocks.handle).toHaveBeenCalledOnce();
  const runs = mocks.command.mock.calls.map(([params]) => params).filter((params) => params.args[0] === 'run');
  expect(runs).toHaveLength(1);
  expect(mocks.stop).toHaveBeenCalledWith(expect.stringMatching(/^tb2-exec:/));
  expect(result().infrastructureError).toMatch(/engine disk pressure/);
  expect(result().mean).toBeNull();
  const removals = mocks.command.mock.calls.map(([params]) => params.args).filter((params) => params[0] === 'rm');
  expect(removals.length).toBeGreaterThan(0);
  expect(removals.every((params) => params[2] === runs[0].args[runs[0].args.indexOf('--name') + 1])).toBe(true);
});

test('removes a task container when startup fails before an environment is returned', async () => {
  const original = mocks.command.getMockImplementation()!;
  mocks.command.mockImplementation(async (params) => {
    if (params.args[0] === 'run') throw new Error('container start failed');
    return original(params);
  });
  await runTerminalBenchNativeCli(args());
  expect(mocks.handle).not.toHaveBeenCalled();
  expect(mocks.command.mock.calls.filter(([params]) => params.args[0] === 'rm')).toHaveLength(3);
  expect(result()).toMatchObject({ errors: 3 });
});
