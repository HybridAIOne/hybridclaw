import { afterEach, expect, test, vi } from 'vitest';

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  });
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
  vi.doUnmock('node:fs');
  vi.doUnmock('../src/logger.js');
  vi.resetModules();
});

test('isProbablyWsl skips /proc probing on non-linux platforms', async () => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const readFileSync = vi.fn(() => 'Linux version 6.0.0 microsoft');

  vi.doMock('../src/logger.js', () => ({ logger }));
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...actual,
      default: {
        ...actual,
        readFileSync,
      },
      readFileSync,
    };
  });

  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  });

  const { isProbablyWsl } = await import('../src/tui-clipboard.ts');

  expect(isProbablyWsl()).toBe(false);
  expect(readFileSync).not.toHaveBeenCalled();
  expect(logger.debug).not.toHaveBeenCalled();
});
