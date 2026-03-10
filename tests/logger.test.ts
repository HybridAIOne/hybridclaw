import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

async function waitForFileText(
  filePath: string,
  matcher: (text: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      if (matcher(text)) return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for log file: ${filePath}`);
}

describe('logger forced level override', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/config/runtime-config.ts');
    delete process.env.HYBRIDCLAW_FORCE_LOG_LEVEL;
    delete process.env.HYBRIDCLAW_GATEWAY_LOG_FILE;
    if (tempDir) {
      void fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('forces debug level over runtime config changes', async () => {
    process.env.HYBRIDCLAW_FORCE_LOG_LEVEL = 'debug';
    let listener:
      | ((
          next: { ops: { logLevel: string } },
          prev: { ops: { logLevel: string } },
        ) => void)
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

  it('mirrors logs to the configured gateway log file', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-logger-'));
    const logPath = path.join(tempDir, 'gateway.log');
    process.env.HYBRIDCLAW_GATEWAY_LOG_FILE = logPath;

    vi.doMock('../src/config/runtime-config.ts', () => ({
      getRuntimeConfig: () => ({
        ops: { logLevel: 'info' },
      }),
      onRuntimeConfigChange: vi.fn(),
    }));

    const { logger } = await import('../src/logger.ts');

    logger.info('foreground log mirror test');

    const logText = await waitForFileText(logPath, (text) =>
      text.includes('foreground log mirror test'),
    );

    expect(logText).toContain('foreground log mirror test');
  });

  it('writes debug logs when the forced level is debug', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-logger-'));
    const logPath = path.join(tempDir, 'gateway.log');
    process.env.HYBRIDCLAW_GATEWAY_LOG_FILE = logPath;
    process.env.HYBRIDCLAW_FORCE_LOG_LEVEL = 'debug';

    vi.doMock('../src/config/runtime-config.ts', () => ({
      getRuntimeConfig: () => ({
        ops: { logLevel: 'info' },
      }),
      onRuntimeConfigChange: vi.fn(),
    }));

    const { logger } = await import('../src/logger.ts');

    logger.debug('forced debug mirror test');

    const logText = await waitForFileText(logPath, (text) =>
      text.includes('forced debug mirror test'),
    );

    expect(logText).toContain('forced debug mirror test');
  });
});
