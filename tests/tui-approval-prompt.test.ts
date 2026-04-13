import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import {
  buildTuiApprovalSelectionOptions,
  promptTuiApprovalSelection,
  renderTuiApprovalPromptLines,
} from '../src/tui-approval-prompt.js';

const PALETTE = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
  red: '',
};

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
    palette: PALETTE,
  });

  expect(lines.join('\n')).toContain('Approval required');
  expect(lines.join('\n')).toContain('Bash command');
  expect(lines.join('\n')).toContain('git status');
  expect(lines.join('\n')).toContain('Do you want to proceed?');
  expect(lines.join('\n')).toContain('> 2. Yes for session');
  expect(lines.join('\n')).toContain('Esc to cancel');
});

function buildApprovalPromptHarness() {
  const writes: string[] = [];
  const originalTtyWrite = vi.fn();
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
  const rl = {
    line: '',
    cursor: 0,
    _refreshLine: vi.fn(),
    _ttyWrite: originalTtyWrite,
    on: vi.fn(),
    off: vi.fn(),
    prompt: vi.fn(),
  } as unknown as readline.Interface;

  return {
    rl: rl as unknown as {
      line: string;
      cursor: number;
      _refreshLine: () => void;
      _ttyWrite: (chunk: string, key: readline.Key) => void;
    },
    output,
    writes,
    originalTtyWrite,
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
    palette: PALETTE,
  });

  harness.rl._ttyWrite('', { name: 'down' });
  harness.rl._ttyWrite('', { name: 'down' });
  harness.rl._ttyWrite('\r', { name: 'return' });

  await expect(prompt).resolves.toBe('agent');
  expect(harness.originalTtyWrite).not.toHaveBeenCalled();
  expect(harness.rl._refreshLine).toHaveBeenCalledTimes(1);
  expect(harness.writes.length).toBeGreaterThan(0);
});

test('promptTuiApprovalSelection can skip prompt redraw before an immediate replay', async () => {
  const harness = buildApprovalPromptHarness();
  const prompt = promptTuiApprovalSelection({
    rl: harness.rl as unknown as readline.Interface,
    approval: APPROVAL,
    options: ['once', 'skip'],
    output: harness.output,
    palette: PALETTE,
    restorePrompt: false,
  });

  harness.rl._ttyWrite('\r', { name: 'return' });

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
    palette: PALETTE,
  });

  numericHarness.rl._ttyWrite('4', { name: '4', sequence: '4' });
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
    palette: PALETTE,
  });

  denyHarness.rl._ttyWrite('\u001b', { name: 'escape', sequence: '\u001b' });
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
      palette: PALETTE,
    }),
  ).resolves.toBeUndefined();
});
