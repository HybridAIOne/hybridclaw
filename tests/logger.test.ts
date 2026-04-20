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

const PROCESS_HANDLER_REGISTRATION_KEY = Symbol.for(
  'hybridclaw.logger.process-handler-registration',
);

interface ProcessWithRegistrationState extends NodeJS.Process {
  [PROCESS_HANDLER_REGISTRATION_KEY]?: {
    uncaughtExceptionHandler: ((err: Error) => void) | null;
    unhandledRejectionHandler: ((reason: unknown) => void) | null;
  };
}

function getHybridClawProcessListenerState() {
  return (process as ProcessWithRegistrationState)[
    PROCESS_HANDLER_REGISTRATION_KEY
  ];
}

function removeHybridClawProcessListeners(): void {
  const state = getHybridClawProcessListenerState();
  if (state?.uncaughtExceptionHandler) {
    process.removeListener(
      'uncaughtException',
      state.uncaughtExceptionHandler as (error: Error) => void,
    );
  }
  if (state?.unhandledRejectionHandler) {
    process.removeListener(
      'unhandledRejection',
      state.unhandledRejectionHandler as (reason: unknown) => void,
    );
  }
}

function resetHybridClawProcessListenerState(): void {
  delete (process as ProcessWithRegistrationState)[
    PROCESS_HANDLER_REGISTRATION_KEY
  ];
}

async function importFreshLogger() {
  removeHybridClawProcessListeners();
  resetHybridClawProcessListenerState();
  vi.resetModules();
  vi.doMock('../src/config/runtime-config.ts', () => ({
    getRuntimeConfig: () => ({
      ops: { logLevel: 'info' },
    }),
    onRuntimeConfigChange: vi.fn(),
  }));
  const module = await import('../src/logger.ts');
  const listener =
    getHybridClawProcessListenerState()?.uncaughtExceptionHandler;
  if (!listener) {
    throw new Error('Failed to register uncaughtExceptionHandler');
  }
  return {
    ...module,
    uncaughtExceptionHandler: listener as (error: Error) => void,
  };
}

describe('logger forced level override', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../src/config/runtime-config.ts');
    removeHybridClawProcessListeners();
    resetHybridClawProcessListenerState();
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

    const { forceLoggerLevel, logger } = await import('../src/logger.ts');

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

  it('keeps expected transport exceptions non-fatal', async () => {
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
      'Handled expected transport exception without exiting',
    );
    expect(fatalSpy).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still exits on generic network errors in uncaughtException', async () => {
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

    uncaughtExceptionHandler(new Error('network error'));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fatalSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Uncaught exception',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
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
    removeHybridClawProcessListeners();
    resetHybridClawProcessListenerState();

    const mockRuntimeConfig = () =>
      vi.doMock('../src/config/runtime-config.ts', () => ({
        getRuntimeConfig: () => ({
          ops: { logLevel: 'info' },
        }),
        onRuntimeConfigChange: vi.fn(),
      }));

    mockRuntimeConfig();
    await import('../src/logger.ts');
    vi.resetModules();
    mockRuntimeConfig();
    await import('../src/logger.ts');

    const state = getHybridClawProcessListenerState();
    if (!state?.uncaughtExceptionHandler || !state.unhandledRejectionHandler) {
      throw new Error('Failed to register logger process handlers');
    }

    expect(
      process
        .listeners('uncaughtException')
        .filter((listener) => listener === state.uncaughtExceptionHandler),
    ).toHaveLength(1);
    expect(
      process
        .listeners('unhandledRejection')
        .filter((listener) => listener === state.unhandledRejectionHandler),
    ).toHaveLength(1);
  });
});
