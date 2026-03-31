import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import {
  formatTuiExitWarning,
  resolveTuiExitAction,
  TuiExitController,
} from '../src/tui-exit.js';

test('formats the exit warning with a five-second confirmation window', () => {
  expect(formatTuiExitWarning()).toBe(
    'Press Ctrl-C or Ctrl-D again within 5 seconds to exit.',
  );
});

test('warns on the first ctrl+c exit attempt', () => {
  expect(
    resolveTuiExitAction({
      key: { ctrl: true, name: 'c' },
      line: '',
      now: 2_000,
      lastExitAttemptAt: 0,
      exitWindowMs: 5_000,
    }),
  ).toEqual({
    action: 'warn',
    nextLastExitAttemptAt: 2_000,
  });
});

test('exits on a second exit attempt within the confirmation window', () => {
  expect(
    resolveTuiExitAction({
      key: { ctrl: true, name: 'd' },
      line: '',
      now: 6_000,
      lastExitAttemptAt: 2_000,
      exitWindowMs: 5_000,
    }),
  ).toEqual({
    action: 'exit',
    nextLastExitAttemptAt: 2_000,
  });
});

test('warns again after the confirmation window elapses', () => {
  expect(
    resolveTuiExitAction({
      key: { ctrl: true, name: 'c' },
      line: '',
      now: 7_001,
      lastExitAttemptAt: 2_000,
      exitWindowMs: 5_000,
    }),
  ).toEqual({
    action: 'warn',
    nextLastExitAttemptAt: 7_001,
  });
});

test('ignores ctrl+d when there is still prompt text', () => {
  expect(
    resolveTuiExitAction({
      key: { ctrl: true, name: 'd' },
      line: 'keep typing',
      now: 2_000,
      lastExitAttemptAt: 0,
      exitWindowMs: 5_000,
    }),
  ).toBeNull();
});

function buildExitControllerHarness() {
  let now = 1_000;
  const originalTtyWrite = vi.fn();
  const rl = {
    line: '',
    _ttyWrite: originalTtyWrite,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as readline.Interface;
  const onWarn = vi.fn();
  const onExit = vi.fn();
  const controller = new TuiExitController({
    rl,
    onWarn,
    onExit,
    exitWindowMs: 5_000,
    now: () => now,
  });

  controller.install();

  return {
    rl: rl as unknown as {
      line: string;
      _ttyWrite: (chunk: string, key: readline.Key) => void;
    },
    onWarn,
    onExit,
    originalTtyWrite,
    advance: (deltaMs: number) => {
      now += deltaMs;
    },
  };
}

test('intercepts the first ctrl+d on an empty prompt', () => {
  const { rl, onWarn, onExit, originalTtyWrite } = buildExitControllerHarness();

  rl._ttyWrite('', { ctrl: true, name: 'd' });

  expect(onWarn).toHaveBeenCalledTimes(1);
  expect(onExit).not.toHaveBeenCalled();
  expect(originalTtyWrite).not.toHaveBeenCalled();
});

test('allows a second ctrl+c within the window to exit', () => {
  const { rl, onWarn, onExit, advance } = buildExitControllerHarness();

  rl._ttyWrite('', { ctrl: true, name: 'c' });
  advance(1_000);
  rl._ttyWrite('', { ctrl: true, name: 'c' });

  expect(onWarn).toHaveBeenCalledTimes(1);
  expect(onExit).toHaveBeenCalledTimes(1);
});

test('passes non-exit keypresses through to readline', () => {
  const { rl, originalTtyWrite } = buildExitControllerHarness();

  rl.line = 'hello';
  rl._ttyWrite('x', { name: 'x' });

  expect(originalTtyWrite).toHaveBeenCalledWith('x', { name: 'x' });
});
