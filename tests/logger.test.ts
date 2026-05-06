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

type LoggerModule = typeof import('../src/logger.ts');

let loadedLoggerModule: LoggerModule | null = null;

async function importLoggerModule(): Promise<LoggerModule> {
  const module = await import('../src/logger.ts');
  loadedLoggerModule = module;
  return module;
}

async function importFreshLogger() {
  loadedLoggerModule?.removeLoggerProcessHandlersForTests();
  loadedLoggerModule = null;
  vi.resetModules();
  vi.doMock('../src/config/runtime-config.ts', () => ({
    getRuntimeConfig: () => ({
      ops: { logLevel: 'info' },
    }),
    onRuntimeConfigChange: vi.fn(),
  }));
  const module = await importLoggerModule();
  return {
    ...module,
    uncaughtExceptionHandler: module.handleUncaughtExceptionForTests,
  };
}

describe('logger forced level override', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/config/runtime-config.ts');
    loadedLoggerModule?.removeLoggerProcessHandlersForTests();
    loadedLoggerModule = null;
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

    const { logger } = await importLoggerModule();

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

    const { logger } = await importLoggerModule();

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

    const { logger } = await importLoggerModule();

    logger.debug('forced debug mirror test');

    const logText = await waitForFileText(logPath, (text) =>
      text.includes('forced debug mirror test'),
    );

    expect(logText).toContain('forced debug mirror test');
  });

  it('can force debug level after the logger was already imported', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hybridclaw-logger-'));
    const logPath = path.join(tempDir, 'gateway.log');
    process.env.HYBRIDCLAW_GATEWAY_LOG_FILE = logPath;
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

    const { forceLoggerLevel, logger } = await importLoggerModule();

    expect(logger.level).toBe('info');
    forceLoggerLevel('debug');
    expect(logger.level).toBe('debug');

    listener?.({ ops: { logLevel: 'error' } }, { ops: { logLevel: 'info' } });
    expect(logger.level).toBe('debug');

    logger.debug('late forced debug mirror test');

    const logText = await waitForFileText(logPath, (text) =>
      text.includes('late forced debug mirror test'),
    );

    expect(logText).toContain('late forced debug mirror test');
  });

  it('keeps running on uncaught transport exceptions', async () => {
    const { logger, uncaughtExceptionHandler } = await importFreshLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);
    const fatalSpy = vi
      .spyOn(logger, 'fatal')
      .mockImplementation(() => undefined);

    uncaughtExceptionHandler(new Error('Opening handshake has timed out'));

    expect(warnSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Uncaught transport exception escaped local handler; keeping process alive',
    );
    expect(fatalSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs transport rejections as recoverable warnings', async () => {
    const { logger, handleUnhandledRejectionForTests } =
      await importFreshLogger();
    const errorSpy = vi
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);

    handleUnhandledRejectionForTests(
      new Error('Opening handshake has timed out'),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Unhandled transport rejection escaped local handler; keeping process alive',
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('still exits on unexpected uncaught exceptions', async () => {
    const { logger, uncaughtExceptionHandler } = await importFreshLogger();
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const warnSpy = vi
      .spyOn(logger, 'warn')
      .mockImplementation(() => undefined);
    const fatalSpy = vi
      .spyOn(logger, 'fatal')
      .mockImplementation(() => undefined);

    uncaughtExceptionHandler(new Error('Invariant violation'));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fatalSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Uncaught exception',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('registers process handlers only once across module reloads', async () => {
    loadedLoggerModule?.removeLoggerProcessHandlersForTests();
    loadedLoggerModule = null;
    vi.resetModules();

    const mockRuntimeConfig = () =>
      vi.doMock('../src/config/runtime-config.ts', () => ({
        getRuntimeConfig: () => ({
          ops: { logLevel: 'info' },
        }),
        onRuntimeConfigChange: vi.fn(),
      }));

    mockRuntimeConfig();
    const firstModule = await importLoggerModule();
    vi.resetModules();
    mockRuntimeConfig();
    const secondModule = await importLoggerModule();

    expect(
      process
        .listeners('uncaughtException')
        .filter(
          (listener) =>
            listener === firstModule.handleUncaughtExceptionForTests ||
            listener === secondModule.handleUncaughtExceptionForTests,
        ),
    ).toHaveLength(1);
    expect(
      process
        .listeners('unhandledRejection')
        .filter(
          (listener) =>
            listener === firstModule.handleUnhandledRejectionForTests ||
            listener === secondModule.handleUnhandledRejectionForTests,
        ),
    ).toHaveLength(1);
  });
});
