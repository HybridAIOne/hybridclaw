import { afterEach, expect, test, vi } from 'vitest';

import { promptForSecretInput } from '../src/utils/secret-prompt.js';

const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: ORIGINAL_STDIN_IS_TTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: ORIGINAL_STDOUT_IS_TTY,
    configurable: true,
  });
});

test('promptForSecretInput suppresses echoed characters when readline output can be muted', async () => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const writes: string[] = [];
  const rl = {
    _writeToOutput: (value: string) => {
      writes.push(value);
    },
    question: vi.fn(async (prompt: string) => {
      (rl as { _writeToOutput?: (value: string) => void })._writeToOutput?.(
        prompt,
      );
      (rl as { _writeToOutput?: (value: string) => void })._writeToOutput?.(
        'super-secret',
      );
      (rl as { _writeToOutput?: (value: string) => void })._writeToOutput?.(
        '\r\n',
      );
      return 'super-secret';
    }),
  };

  const value = await promptForSecretInput({
    prompt: 'Password: ',
    rl: rl as never,
  });

  expect(value).toBe('super-secret');
  expect(writes).toEqual(['Password: ', '\r\n']);
});

test('promptForSecretInput pauses stdin again after hidden tty input completes', async () => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const originalSetRawMode = process.stdin.setRawMode;
  const originalResume = process.stdin.resume;
  const originalPause = process.stdin.pause;
  const originalOn = process.stdin.on;
  const originalOff = process.stdin.off;
  const originalIsPaused = process.stdin.isPaused;
  const originalIsRaw = process.stdin.isRaw;

  const writes: string[] = [];
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;

  process.stdin.setRawMode = vi.fn() as typeof process.stdin.setRawMode;
  process.stdin.resume = vi.fn(
    () => process.stdin,
  ) as typeof process.stdin.resume;
  process.stdin.pause = vi.fn(
    () => process.stdin,
  ) as typeof process.stdin.pause;
  process.stdin.on = vi.fn(((
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'data') {
      dataHandler = listener as (chunk: string | Buffer) => void;
    }
    return process.stdin;
  }) as typeof process.stdin.on);
  process.stdin.off = vi.fn(() => process.stdin) as typeof process.stdin.off;
  process.stdin.isPaused = vi.fn(() => true) as typeof process.stdin.isPaused;
  Object.defineProperty(process.stdin, 'isRaw', {
    value: false,
    configurable: true,
  });

  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);

  try {
    const promptPromise = promptForSecretInput({
      prompt: 'Password: ',
    });

    expect(dataHandler).toBeDefined();
    dataHandler?.('super-secret\n');

    const value = await promptPromise;

    expect(value).toBe('super-secret');
    expect(process.stdin.resume).toHaveBeenCalledTimes(1);
    expect(process.stdin.pause).toHaveBeenCalledTimes(1);
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(process.stdin.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(writes).toEqual(['Password: ', '\n']);
  } finally {
    process.stdin.setRawMode = originalSetRawMode;
    process.stdin.resume = originalResume;
    process.stdin.pause = originalPause;
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    process.stdin.isPaused = originalIsPaused;
    Object.defineProperty(process.stdin, 'isRaw', {
      value: originalIsRaw,
      configurable: true,
    });
    writeSpy.mockRestore();
  }
});
