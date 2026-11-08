import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const mocks = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn() }));
vi.mock('../eval-harness/src/benchmark-resources.js', async (original) => ({
  ...(await original<
    typeof import('../eval-harness/src/benchmark-resources.js')
  >()),
  BenchmarkResources: class {
    signal = new AbortController().signal;
    start = mocks.start;
    close = mocks.close;
    abort() {}
  },
}));
const temporary = useTempDir('benchmark-cleanup-');
useCleanMocks({
  cleanup: () => {
    mocks.start.mockReset();
    mocks.close.mockReset();
  },
});

test.each([false, true])(
  'the native runner retains its primary failure when cleanup also fails: %s',
  async (cleanupFails) => {
    const root = temporary();
    const primary = new Error('Fixture benchmark admission failed.');
    const cleanup = new Error('Fixture probe cleanup failed.');
    mocks.start.mockRejectedValue(primary);
    mocks.close.mockImplementation(async () => {
      if (cleanupFails) throw cleanup;
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runTerminalBenchNativeCli } = await import(
      '../eval-harness/src/terminal-bench-native.js'
    );
    const result = runTerminalBenchNativeCli([
      '--install-dir',
      root,
      '--data-dir',
      root,
      '--model',
      'test-model',
    ]);
    if (cleanupFails)
      await expect(result).rejects.toMatchObject({
        cause: primary,
        errors: [primary, cleanup],
      });
    else await expect(result).rejects.toBe(primary);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  },
);
