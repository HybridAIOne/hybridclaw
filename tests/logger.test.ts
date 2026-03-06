import { afterEach, describe, expect, it, vi } from 'vitest';

describe('logger forced level override', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/config/runtime-config.ts');
    delete process.env.HYBRIDCLAW_FORCE_LOG_LEVEL;
  });

  it('forces debug level over runtime config changes', async () => {
    process.env.HYBRIDCLAW_FORCE_LOG_LEVEL = 'debug';
    let listener:
      | ((next: { ops: { logLevel: string } }, prev: { ops: { logLevel: string } }) => void)
      | null = null;

    vi.doMock('../src/config/runtime-config.ts', () => ({
      getRuntimeConfig: () => ({
        ops: { logLevel: 'info' },
      }),
      onRuntimeConfigChange: vi.fn((cb) => {
        listener = cb;
      }),
    }));

    const { logger } = await import('../src/logger.ts');

    expect(logger.level).toBe('debug');
    listener?.({ ops: { logLevel: 'error' } }, { ops: { logLevel: 'info' } });
    expect(logger.level).toBe('debug');
  });
});
