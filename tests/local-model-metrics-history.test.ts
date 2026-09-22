import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LocalModelMetricsHistory } from '../src/inference/local-model-metrics-history.js';
import type { LocalModelMetrics } from '../src/inference/local-model-metrics.js';

const sample = (): LocalModelMetrics => ({
  sampledAt: Date.now(), cpuPercent: 25, memoryUsedBytes: 100, memoryTotalBytes: 200,
  gpuPercent: 50, tokensPerSecond: 10, generatedTokens: 100, runtimeId: 'a'.repeat(32),
});
let history: LocalModelMetricsHistory;
let collect: ReturnType<typeof vi.fn<() => Promise<LocalModelMetrics>>>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  collect = vi.fn(async () => sample());
  history = new LocalModelMetricsHistory(collect);
});
afterEach(async () => { await history.close(); vi.useRealTimers(); });

test('starts immediately and retains one-second samples without any page requests', async () => {
  history.start();
  history.start();
  await vi.advanceTimersByTimeAsync(65_000);
  expect(collect).toHaveBeenCalledTimes(66);
  const samples = history.snapshot();
  expect(samples).toHaveLength(60);
  expect(samples[0].sampledAt).toBe(106_000);
  expect(samples.at(-1)?.sampledAt).toBe(165_000);
  expect(samples.slice(1).every((entry, i) => entry.sampledAt - samples[i].sampledAt === 1000)).toBe(true);
  expect(history.snapshot()).toEqual(samples);
  samples[0].cpuPercent = 0;
  samples.pop();
  expect(history.snapshot()).toHaveLength(60);
  expect(history.snapshot()[0].cpuPercent).toBe(25);
});

test('does not overlap a slow probe and resumes on the next tick', async () => {
  let finish!: (value: LocalModelMetrics) => void;
  collect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  history.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(collect).toHaveBeenCalledOnce();
  expect(history.snapshot()).toEqual([]);
  finish(sample());
  await vi.advanceTimersByTimeAsync(1000);
  expect(collect).toHaveBeenCalledTimes(2);
  expect(history.snapshot()).toHaveLength(2);
});

test('keeps failed probes as gaps, recovers, and never exposes raw errors', async () => {
  history.start();
  await vi.advanceTimersByTimeAsync(0);
  collect.mockRejectedValue(new Error('private-runtime-payload'));
  await vi.advanceTimersByTimeAsync(4000);
  expect(history.snapshot()).toHaveLength(1);
  expect(JSON.stringify(history.snapshot())).not.toContain('private-runtime-payload');
  collect.mockImplementation(async () => sample());
  await vi.advanceTimersByTimeAsync(1000);
  expect(history.snapshot().map((entry) => entry.sampledAt)).toEqual([100_000, 105_000]);
  collect.mockRejectedValue(new Error('private-runtime-payload'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(history.snapshot()).toEqual([]);
});

test('drops stale samples after a forward clock jump and resets on a backward jump', async () => {
  history.start();
  await vi.advanceTimersByTimeAsync(2000);
  vi.setSystemTime(200_000);
  expect(history.snapshot()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(history.snapshot()).toHaveLength(1);
  vi.setSystemTime(50_000);
  expect(history.snapshot()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(history.snapshot().map((entry) => entry.sampledAt)).toEqual([51_000]);
});

test('shutdown stops the timer, drains an in-flight probe and prevents late writes or restarts', async () => {
  let finish!: (value: LocalModelMetrics) => void;
  collect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  history.start();
  const closing = history.close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(collect).toHaveBeenCalledOnce();
  finish(sample());
  await closing;
  expect(history.snapshot()).toEqual([]);
  history.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(collect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
