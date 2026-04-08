import { afterEach, expect, test, vi } from 'vitest';

import { promptForSecretInput } from '../src/utils/secret-prompt.js';

const ORIGINAL_STDIN_IS_TTY = process.stdin.isTTY;
const ORIGINAL_STDOUT_IS_TTY = process.stdout.isTTY;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doUnmock('node:tty');
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
  expect(writes).toEqual(['🔒 Paste Password: ', '\r\n']);
});

test('promptForSecretInput pauses stdin again after hidden tty input completes when stdin was idle', async () => {
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
  const originalIsRaw = process.stdin.isRaw;
  const originalReadableFlowing = process.stdin.readableFlowing;

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
  Object.defineProperty(process.stdin, 'isRaw', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdin, 'readableFlowing', {
    value: null,
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
    expect(writes).toEqual(['🔒 Paste Password: ', '\n']);
  } finally {
    process.stdin.setRawMode = originalSetRawMode;
    process.stdin.resume = originalResume;
    process.stdin.pause = originalPause;
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    Object.defineProperty(process.stdin, 'isRaw', {
      value: originalIsRaw,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'readableFlowing', {
      value: originalReadableFlowing,
      configurable: true,
    });
    writeSpy.mockRestore();
  }
});

test('promptForSecretInput switches to a fresh tty when stdin still has readline listeners', async () => {
  Object.defineProperty(process.stdin, 'isTTY', {
    value: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: true,
    configurable: true,
  });

  const openSync = vi.fn((target: string) =>
    target.endsWith('tty') ? 11 : 12,
  );
  const closeSync = vi.fn();
  const writes: string[] = [];
  let dataHandler: ((chunk: string | Buffer) => void) | undefined;

  class FakeReadStream {
    isRaw = false;

    setRawMode = vi.fn((value: boolean) => {
      this.isRaw = value;
    });

    resume = vi.fn(() => this);

    pause = vi.fn(() => this);

    isPaused = vi.fn(() => true);

    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'data') {
        dataHandler = listener as (chunk: string | Buffer) => void;
      }
      return this;
    });

    off = vi.fn(() => this);

    destroy = vi.fn();
  }

  class FakeWriteStream {
    write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    destroy = vi.fn();
  }

  vi.doMock('node:fs', () => ({
    default: { openSync, closeSync },
    openSync,
    closeSync,
  }));
  vi.doMock('node:tty', () => ({
    default: {
      ReadStream: FakeReadStream,
      WriteStream: FakeWriteStream,
    },
    ReadStream: FakeReadStream,
    WriteStream: FakeWriteStream,
  }));

  const listenerCountSpy = vi
    .spyOn(process.stdin, 'listenerCount')
    .mockImplementation((event: string | symbol) => (event === 'data' ? 1 : 0));

  const { promptForSecretInput: promptWithFreshTty } = await import(
    '../src/utils/secret-prompt.ts'
  );

  const promptPromise = promptWithFreshTty({ prompt: 'Password: ' });
  expect(dataHandler).toBeDefined();
  dataHandler?.('secret-from-dedicated-tty\n');

  const value = await promptPromise;

  expect(value).toBe('secret-from-dedicated-tty');
  expect(openSync).toHaveBeenNthCalledWith(
    1,
    process.platform === 'win32' ? 'CONIN$' : '/dev/tty',
    'r',
  );
  expect(openSync).toHaveBeenNthCalledWith(
    2,
    process.platform === 'win32' ? 'CONOUT$' : '/dev/tty',
    'w',
  );
  expect(listenerCountSpy).toHaveBeenCalledWith('data');
  expect(writes).toEqual(['🔒 Paste Password: ', '\n']);
});

test('promptForSecretInput prefers raw tty input over readline when available', async () => {
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
  const originalReadableFlowing = process.stdin.readableFlowing;

  let dataHandler: ((chunk: string | Buffer) => void) | undefined;
  const writes: string[] = [];

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

  const rl = {
    question: vi.fn(async () => 'should-not-be-used'),
    pause: vi.fn(),
    resume: vi.fn(),
  };

  try {
    const promptPromise = promptForSecretInput({
      prompt: '🔒 Paste Email password or app password: ',
      rl: rl as never,
    });

    expect(dataHandler).toBeDefined();
    dataHandler?.('secret-value\n');

    const value = await promptPromise;

    expect(value).toBe('secret-value');
    expect(rl.pause).toHaveBeenCalledTimes(1);
    expect(rl.resume).toHaveBeenCalledTimes(1);
    expect(rl.question).not.toHaveBeenCalled();
    expect(writes).toEqual(['🔒 Paste Email password or app password: ', '\n']);
  } finally {
    process.stdin.setRawMode = originalSetRawMode;
    process.stdin.resume = originalResume;
    process.stdin.pause = originalPause;
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    Object.defineProperty(process.stdin, 'isRaw', {
      value: originalIsRaw,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'readableFlowing', {
      value: originalReadableFlowing,
      configurable: true,
    });
    writeSpy.mockRestore();
  }
});

test('promptForSecretInput keeps stdin flowing when it was already flowing', async () => {
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
  const originalIsRaw = process.stdin.isRaw;
  const originalReadableFlowing = process.stdin.readableFlowing;

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
  Object.defineProperty(process.stdin, 'isRaw', {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdin, 'readableFlowing', {
    value: true,
    configurable: true,
  });

  const writeSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((() => true) as typeof process.stdout.write);

  try {
    const promptPromise = promptForSecretInput({
      prompt: 'Password: ',
    });

    expect(dataHandler).toBeDefined();
    dataHandler?.('super-secret\n');

    const value = await promptPromise;

    expect(value).toBe('super-secret');
    expect(process.stdin.resume).toHaveBeenCalledTimes(1);
    expect(process.stdin.pause).not.toHaveBeenCalled();
  } finally {
    process.stdin.setRawMode = originalSetRawMode;
    process.stdin.resume = originalResume;
    process.stdin.pause = originalPause;
    process.stdin.on = originalOn;
    process.stdin.off = originalOff;
    Object.defineProperty(process.stdin, 'isRaw', {
      value: originalIsRaw,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'readableFlowing', {
      value: originalReadableFlowing,
      configurable: true,
    });
    writeSpy.mockRestore();
  }
});
