import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import {
  buildTuiApprovalSelectionOptions,
  promptTuiApprovalSelection,
  renderTuiApprovalPromptLines,
} from '../src/tui-approval-prompt.js';

// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const ANSI_PATTERN = new RegExp('\\u001B\\[[0-9;]*[A-Za-z]', 'g');
// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const CONTROL_PATTERN = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');
// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const REDRAW_PATTERN = new RegExp(
  '^(?:\\u001B\\[\\d+A)?\\r\\u001B\\[J\\u001B\\[\\?25l',
  'u',
);
// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const RESTORE_PATTERN = new RegExp(
  '^(?:\\u001B\\[\\d+A)?\\r\\u001B\\[J\\u001B\\[\\?25h$',
  'u',
);

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

test('buildTuiApprovalSelectionOptions keeps once first and skip last', () => {
  expect(
    buildTuiApprovalSelectionOptions({
      allowSession: true,
      allowAgent: true,
      allowAll: true,
    }),
  ).toEqual(['once', 'session', 'agent', 'all', 'skip']);
});

test('renderTuiApprovalPromptLines highlights the selected row and help text', () => {
  const lines = renderTuiApprovalPromptLines({
    approval: {
      approvalId: 'approve123',
      intent: 'run shell command `git status`',
      reason: 'this command may change local state',
    },
    options: ['once', 'session', 'skip'],
    cursor: 1,
    width: 80,
  });
  const text = stripAnsi(lines.join('\n'));

  expect(text).toContain('Approval required');
  expect(text).toContain('Bash command');
  expect(text).toContain('git status');
  expect(text).toContain('Do you want to proceed?');
  expect(text).toContain('> 2. Yes for session');
  expect(text).toContain('Esc to skip');
});

test('renderTuiApprovalPromptLines truncates ANSI-styled preview lines', () => {
  const lines = renderTuiApprovalPromptLines({
    approval: {
      approvalId: 'approve123',
      intent:
        'run shell command `git status --branch --short --show-stash --ahead-behind`',
      reason: 'this command may change local state',
    },
    options: ['once', 'skip'],
    cursor: 0,
    width: 24,
  });

  expect(
    lines.some((line) => line.includes('...') && line.endsWith('\x1b[0m')),
  ).toBe(true);
});

test('renderTuiApprovalPromptLines strips disallowed terminal control sequences from gateway content', () => {
  const lines = renderTuiApprovalPromptLines({
    approval: {
      approvalId: 'approve123',
      intent:
        'run shell command `git status\x1b]0;owned\x07\x1b[31m --short\x1b[0m`',
      reason: 'this command may \x1b[2Jchange local state\x07',
    },
    options: ['once', 'skip'],
    cursor: 0,
    width: 80,
  });
  const output = lines.join('\n');
  const text = stripAnsi(output).replace(CONTROL_PATTERN, '');

  expect(output).not.toContain('\x1b]0;owned\x07');
  expect(output).not.toContain('\x1b[2J');
  expect(output).not.toContain('\x07');
  expect(output).toContain('\x1b[31m --short\x1b[0m');
  expect(text).toContain('git status --short');
  expect(text).toContain('Why: this command may change local state');
});

function buildApprovalPromptHarness() {
  const writes: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;
  const lineListener = vi.fn();
  const sigintListener = vi.fn();
  const rl = {
    line: '',
    cursor: 0,
    _ttyWrite: vi.fn(),
    _refreshLine: vi.fn(),
    listeners: vi.fn((event: string) => {
      if (event === 'line') return [lineListener];
      if (event === 'SIGINT') return [sigintListener];
      return [];
    }),
    on: vi.fn(),
    off: vi.fn(),
    prompt: vi.fn(),
  } as unknown as readline.Interface;
  return {
    rl: rl as unknown as {
      line: string;
      cursor: number;
      _ttyWrite: (chunk: string, key: readline.Key) => void;
      _refreshLine: () => void;
      listeners: (event: string) => unknown[];
    },
    output,
    writes,
    pressKey: (chunk: string, key: readline.Key) => {
      rl._ttyWrite(chunk, key);
    },
  };
}

const APPROVAL = {
  approvalId: 'approve123',
  intent: 'run shell command `git status`',
  reason: 'this command may change local state',
} as const;

test('promptTuiApprovalSelection moves with arrows and confirms the highlighted option', async () => {
  const harness = buildApprovalPromptHarness();
  const prompt = promptTuiApprovalSelection({
    rl: harness.rl as unknown as readline.Interface,
    approval: APPROVAL,
    options: ['once', 'session', 'agent', 'skip'],
    output: harness.output,
  });

  expect(harness.writes).toHaveLength(1);
  expect(harness.writes[0]?.startsWith('\r\x1b[J\x1b[?25l')).toBe(true);
  harness.pressKey('', { name: 'down' });
  expect(harness.writes).toHaveLength(2);
  expect(harness.writes[1]).toMatch(REDRAW_PATTERN);
  harness.pressKey('', { name: 'down' });
  expect(harness.writes).toHaveLength(3);
  expect(harness.writes[2]).toMatch(REDRAW_PATTERN);
  harness.pressKey('\r', { name: 'return' });

  await expect(prompt).resolves.toBe('agent');
  expect(harness.rl._refreshLine).toHaveBeenCalledTimes(1);
  expect(harness.writes.at(-1)).toMatch(RESTORE_PATTERN);
});

test('promptTuiApprovalSelection can skip prompt redraw before an immediate replay', async () => {
  const harness = buildApprovalPromptHarness();
  const prompt = promptTuiApprovalSelection({
    rl: harness.rl as unknown as readline.Interface,
    approval: APPROVAL,
    options: ['once', 'skip'],
    output: harness.output,
    restorePrompt: false,
  });

  harness.pressKey('\r', { name: 'return' });

  await expect(prompt).resolves.toBe('once');
  expect(harness.rl._refreshLine).not.toHaveBeenCalled();
});

test('promptTuiApprovalSelection supports numeric quick select and escape deny', async () => {
  const numericHarness = buildApprovalPromptHarness();
  const numericPrompt = promptTuiApprovalSelection({
    rl: numericHarness.rl as unknown as readline.Interface,
    approval: APPROVAL,
    options: ['once', 'session', 'agent', 'all', 'skip'],
    output: numericHarness.output,
  });

  numericHarness.pressKey('y', { name: 'y', sequence: 'y' });
  numericHarness.pressKey('4', { name: '4', sequence: '4' });
  await expect(numericPrompt).resolves.toBe('all');

  const denyHarness = buildApprovalPromptHarness();
  const denyPrompt = promptTuiApprovalSelection({
    rl: denyHarness.rl as unknown as readline.Interface,
    approval: {
      ...APPROVAL,
      approvalId: 'approve999',
    },
    options: ['once', 'skip'],
    output: denyHarness.output,
  });

  denyHarness.pressKey('\u001b', {
    name: 'escape',
    sequence: '\u001b',
  });
  await expect(denyPrompt).resolves.toBe('skip');
});

test('promptTuiApprovalSelection returns undefined without a tty renderer', async () => {
  const harness = buildApprovalPromptHarness();
  const output = {
    ...harness.output,
    isTTY: false,
  } as NodeJS.WriteStream;

  await expect(
    promptTuiApprovalSelection({
      rl: harness.rl as unknown as readline.Interface,
      approval: APPROVAL,
      options: ['once', 'skip'],
      output,
    }),
  ).resolves.toBeUndefined();
});

test('promptTuiApprovalSelection throws when called without approval options', async () => {
  const harness = buildApprovalPromptHarness();

  await expect(
    promptTuiApprovalSelection({
      rl: harness.rl as unknown as readline.Interface,
      approval: APPROVAL,
      options: [],
      output: harness.output,
    }),
  ).rejects.toThrow('TUI approval prompt requires at least one option.');
});
