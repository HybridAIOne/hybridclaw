import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import {
  isTuiMultilineEnterKey,
  TuiMultilineInputController,
} from '../src/tui-input.js';

function buildUnknownReadlineKey(sequence: string): readline.Key {
  // Node 22 readline uses the literal string 'undefined' for unsupported
  // escape sequences instead of leaving `name` unset.
  return {
    name: 'undefined',
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
  };
}

test('treats readline linefeed enter (Ctrl-J) as a multiline insert', () => {
  expect(
    isTuiMultilineEnterKey({
      name: 'enter',
      sequence: '\n',
      ctrl: false,
      meta: false,
      shift: false,
    }),
  ).toBe(true);
});

test('treats explicit ctrl-j keypresses as multiline inserts', () => {
  expect(
    isTuiMultilineEnterKey({
      name: 'j',
      sequence: '\n',
      ctrl: true,
      meta: false,
      shift: false,
    }),
  ).toBe(true);
});

test('treats shifted return sequences as multiline inserts', () => {
  expect(
    isTuiMultilineEnterKey({
      name: 'return',
      sequence: '\r',
      shift: true,
    }),
  ).toBe(true);
  expect(isTuiMultilineEnterKey(buildUnknownReadlineKey('\x1b[13;2u'))).toBe(
    true,
  );
  expect(isTuiMultilineEnterKey(buildUnknownReadlineKey('\x1b[13;2~'))).toBe(
    true,
  );
});

test('keeps plain return mapped to submit', () => {
  expect(
    isTuiMultilineEnterKey({
      name: 'return',
      sequence: '\r',
      ctrl: false,
      meta: false,
      shift: false,
    }),
  ).toBe(false);
});

test('intercepts multiline enter and inserts a newline into the readline buffer', () => {
  const inserted: string[] = [];
  const originalTtyWrite = vi.fn();
  const closeHandlers: Array<() => void> = [];
  const off = vi.fn();
  const rl = {
    _insertString: vi.fn((value: string) => {
      inserted.push(value);
    }),
    _ttyWrite: originalTtyWrite,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    off,
  } as unknown as readline.Interface;

  const controller = new TuiMultilineInputController({ rl });
  controller.install();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', {
    name: 'enter',
    sequence: '\n',
    ctrl: false,
    meta: false,
    shift: false,
  });

  expect(inserted).toEqual(['\n']);
  expect(originalTtyWrite).not.toHaveBeenCalled();

  for (const handler of closeHandlers) {
    handler();
  }
  expect(off).toHaveBeenCalledWith('close', closeHandlers[0]);
});

test('passes plain return through to readline submit handling', () => {
  const originalTtyWrite = vi.fn();
  const rl = {
    _insertString: vi.fn(),
    _ttyWrite: originalTtyWrite,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as readline.Interface;

  const controller = new TuiMultilineInputController({ rl });
  controller.install();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('\r', {
    name: 'return',
    sequence: '\r',
    ctrl: false,
    meta: false,
    shift: false,
  });

  expect(originalTtyWrite).toHaveBeenCalledWith('\r', {
    name: 'return',
    sequence: '\r',
    ctrl: false,
    meta: false,
    shift: false,
  });
});

test('consumes split shift-return sequences and inserts a newline', () => {
  const inserted: string[] = [];
  const originalTtyWrite = vi.fn();
  const rl = {
    _insertString: vi.fn((value: string) => {
      inserted.push(value);
    }),
    _ttyWrite: originalTtyWrite,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as readline.Interface;

  const controller = new TuiMultilineInputController({ rl });
  controller.install();

  const ttyWrite = (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite;

  ttyWrite('', {
    ...buildUnknownReadlineKey('\x1b[27;2;'),
    code: '[27;2;',
  });
  ttyWrite('1', {
    name: '1',
    sequence: '1',
    ctrl: false,
    meta: false,
    shift: false,
  });
  ttyWrite('3', {
    name: '3',
    sequence: '3',
    ctrl: false,
    meta: false,
    shift: false,
  });
  ttyWrite('~', {
    name: undefined,
    sequence: '~',
    ctrl: false,
    meta: false,
    shift: false,
  });

  expect(inserted).toEqual(['\n']);
  expect(originalTtyWrite).not.toHaveBeenCalled();
});
