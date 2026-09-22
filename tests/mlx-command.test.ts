import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleMlxCommand } from '../src/inference/mlx-command.js';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), health: vi.fn(), start: vi.fn(), stop: vi.fn(), delay: vi.fn() }));
vi.mock('../src/inference/mlx-connection.js', () => ({ connectMlxModel: mocks.connect }));
vi.mock('../src/inference/mlx-runtime.js', () => ({ mlxHome: () => '/tmp/example-mlx', mlxHealth: mocks.health, startMlxChild: mocks.start, stopMlxChild: mocks.stop }));
vi.mock('../src/inference/mlx-install.js', () => ({ installMlxModel: vi.fn() }));
vi.mock('../src/inference/mlx-benchmark.js', () => ({ benchmarkMlx: vi.fn() }));
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  mocks.health.mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

test('serve connects an existing worker without starting or stopping it', async () => {
  mocks.health.mockResolvedValue({ status: 'ready' });
  await handleMlxCommand(['serve']);
  expect(mocks.connect).toHaveBeenCalledWith({ home: '/tmp/example-mlx', route: 'cli.local.serve' });
  expect(mocks.start).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled();
});

test('serve connects after startup without selecting a default', async () => {
  const child = Object.assign(new EventEmitter(), { exitCode: 0 }) as ChildProcess;
  mocks.start.mockResolvedValue(child);
  await handleMlxCommand(['serve']);
  expect(mocks.start.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]);
  expect(mocks.connect).toHaveBeenCalledExactlyOnceWith({ home: '/tmp/example-mlx', route: 'cli.local.serve' });
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(child);
});

test('failed registration unloads each owned child before retrying', async () => {
  const children = Array.from({ length: 3 }, () => Object.assign(new EventEmitter(), { exitCode: null }) as ChildProcess);
  children.forEach((child) => mocks.start.mockResolvedValueOnce(child));
  mocks.connect.mockImplementation(() => { throw new Error('Registration failed'); });
  await expect(handleMlxCommand(['serve'])).rejects.toThrow('Registration failed');
  expect(mocks.stop.mock.calls.map(([child]) => child)).toEqual(children);
  expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[1]);
});
