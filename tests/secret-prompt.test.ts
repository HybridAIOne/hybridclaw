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
