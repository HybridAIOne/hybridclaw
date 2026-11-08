import { expect, test, vi } from 'vitest';
import { FullAutoLifecycle } from '../src/gateway/fullauto-lifecycle.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ cleanup: () => vi.useRealTimers() });

test('a continuation due during a run waits and executes once after completion', async () => {
  vi.useFakeTimers();
  const lifecycle = new FullAutoLifecycle();
  lifecycle.begin(1);
  const run = vi.fn();
  lifecycle.schedule(10, run);
  await vi.advanceTimersByTimeAsync(20);
  expect(run).not.toHaveBeenCalled();
  lifecycle.finish(1);
  await Promise.resolve();
  expect(run).toHaveBeenCalledOnce();
  lifecycle.finish(1);
  expect(run).toHaveBeenCalledOnce();
  lifecycle.dispose();
});

test('disposing cancels both timers and invalidates progress ownership and late finalizers', async () => {
  vi.useFakeTimers();
  const old = new FullAutoLifecycle();
  const run = vi.fn();
  const check = vi.fn();
  old.begin(1);
  old.schedule(10, run);
  old.watch(1, 5, check);
  old.dispose();
  old.finish(1);
  await vi.advanceTimersByTimeAsync(30);
  expect(old.owns(1)).toBe(false);
  expect(old.begin(2)).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});

test('watchdog interruption happens once and a stale finish cannot release the next run', async () => {
  vi.useFakeTimers();
  const lifecycle = new FullAutoLifecycle();
  lifecycle.begin(1);
  const interrupted = vi.fn(() => lifecycle.interrupt(1));
  lifecycle.watch(1, 5, interrupted);
  await vi.advanceTimersByTimeAsync(20);
  expect(interrupted).toHaveBeenCalledOnce();
  expect(lifecycle.takeInterruption(1)).toBe(true);
  expect(lifecycle.takeInterruption(1)).toBe(false);
  lifecycle.finish(1);
  expect(lifecycle.begin(2)).toBe(true);
  lifecycle.finish(1);
  expect(lifecycle.owns(2)).toBe(true);
  lifecycle.dispose();
});

test('replaced and cancelled schedules cannot dispatch an old callback', async () => {
  vi.useFakeTimers();
  const lifecycle = new FullAutoLifecycle();
  const old = vi.fn();
  const current = vi.fn();
  lifecycle.schedule(5, old);
  lifecycle.schedule(10, current);
  await vi.advanceTimersByTimeAsync(20);
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
  lifecycle.schedule(1, old);
  lifecycle.cancelScheduled();
  await vi.advanceTimersByTimeAsync(20);
  expect(old).not.toHaveBeenCalled();
  lifecycle.dispose();
});


test('disposal invalidates a due continuation already queued by completion', async () => {
  vi.useFakeTimers();
  const lifecycle = new FullAutoLifecycle();
  const run = vi.fn();
  lifecycle.begin(1);
  lifecycle.schedule(1, run);
  await vi.advanceTimersByTimeAsync(2);
  lifecycle.finish(1);
  lifecycle.dispose();
  await Promise.resolve();
  expect(run).not.toHaveBeenCalled();
});
