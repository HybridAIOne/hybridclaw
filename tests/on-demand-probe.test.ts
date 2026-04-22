import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function importFreshModule() {
  vi.resetModules();
  return import('../src/providers/on-demand-probe.js');
}

describe('createOnDemandProbe', () => {
  test('get() calls probeFn and returns result', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue({ ok: true });

    const probe = createOnDemandProbe(probeFn, 30_000);
    const result = await probe.get();

    expect(result).toEqual({ ok: true });
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  test('get() returns cached value within TTL', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue('first');

    const probe = createOnDemandProbe(probeFn, 30_000);
    await probe.get();
    const second = await probe.get();

    expect(second).toBe('first');
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  test('get() re-probes after TTL expires', async () => {
    vi.useFakeTimers();
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi
      .fn()
      .mockResolvedValueOnce('first')
      .mockResolvedValueOnce('second');

    const probe = createOnDemandProbe(probeFn, 30_000);
    const r1 = await probe.get();
    expect(r1).toBe('first');

    vi.advanceTimersByTime(30_001);
    const r2 = await probe.get();
    expect(r2).toBe('second');
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  test('concurrent get() calls coalesce on the same promise', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue('coalesced');

    const probe = createOnDemandProbe(probeFn, 30_000);
    const [a, b, c] = await Promise.all([
      probe.get(),
      probe.get(),
      probe.get(),
    ]);

    expect(a).toBe('coalesced');
    expect(b).toBe('coalesced');
    expect(c).toBe('coalesced');
    expect(probeFn).toHaveBeenCalledTimes(1);
  });

  test('peek() returns null before first probe', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue('value');

    const probe = createOnDemandProbe(probeFn, 30_000);
    expect(probe.peek()).toBeNull();
  });

  test('peek() returns cached value after probe', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue('cached');

    const probe = createOnDemandProbe(probeFn, 30_000);
    await probe.get();
    expect(probe.peek()).toBe('cached');
  });

  test('peek() does not trigger a probe', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockResolvedValue('value');

    const probe = createOnDemandProbe(probeFn, 30_000);
    probe.peek();
    probe.peek();
    expect(probeFn).not.toHaveBeenCalled();
  });

  test('invalidate() causes next get() to re-probe', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi
      .fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');

    const probe = createOnDemandProbe(probeFn, 30_000);
    await probe.get();
    expect(probe.peek()).toBe('before');

    probe.invalidate();
    expect(probe.peek()).toBeNull();

    const result = await probe.get();
    expect(result).toBe('after');
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  test('probe error propagates to caller', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi.fn().mockRejectedValue(new Error('network down'));

    const probe = createOnDemandProbe(probeFn, 30_000);
    await expect(probe.get()).rejects.toThrow('network down');
  });

  test('probe error does not cache — next get() retries', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    const probeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');

    const probe = createOnDemandProbe(probeFn, 30_000);
    await expect(probe.get()).rejects.toThrow('transient');
    expect(probe.peek()).toBeNull();

    const result = await probe.get();
    expect(result).toBe('recovered');
    expect(probeFn).toHaveBeenCalledTimes(2);
  });

  test('inflight clears after error so next call retries', async () => {
    const { createOnDemandProbe } = await importFreshModule();
    let callCount = 0;
    const probeFn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('fail');
      return 'ok';
    });

    const probe = createOnDemandProbe(probeFn, 30_000);
    await expect(probe.get()).rejects.toThrow('fail');

    const result = await probe.get();
    expect(result).toBe('ok');
  });
});
