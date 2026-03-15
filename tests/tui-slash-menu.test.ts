import type readline from 'node:readline';

import { expect, test, vi } from 'vitest';

import {
  buildTuiSlashMenuEntries,
  rankTuiSlashMenuEntries,
  resolveTuiSlashMenuQuery,
  TuiSlashMenuController,
} from '../src/tui-slash-menu.js';

test('builds canonical, choice-based, and TUI-only slash menu entries', () => {
  const entries = buildTuiSlashMenuEntries();
  const labels = entries.map((entry) => entry.label);

  expect(labels).toContain('/show tools');
  expect(labels).toContain('/model select');
  expect(labels).toContain('/approve yes [approval_id]');
  expect(labels).toContain('/fullauto on [prompt]');
  expect(labels).toContain('/bot list');
});

test('resolves slash menu queries only at the end of the active line', () => {
  const slashInput = '/mod';
  const spacedInput = '/model ';
  const quotedInput = '/schedule add "*/5 * * * *"';
  const plainInput = 'plain text';

  expect(resolveTuiSlashMenuQuery(slashInput, slashInput.length)).toBe('mod');
  expect(resolveTuiSlashMenuQuery(spacedInput, spacedInput.length)).toBe(
    'model',
  );
  expect(resolveTuiSlashMenuQuery('/model set', 3)).toBeNull();
  expect(resolveTuiSlashMenuQuery(quotedInput, quotedInput.length)).toBeNull();
  expect(resolveTuiSlashMenuQuery(plainInput, plainInput.length)).toBeNull();
});

test('fuzzy ranking prefers the model command for compact queries', () => {
  const ranked = rankTuiSlashMenuEntries(buildTuiSlashMenuEntries(), 'mdl');

  expect(ranked[0]?.label).toBe('/model');
  expect(ranked.some((entry) => entry.label === '/model set <name>')).toBe(
    true,
  );
});

test('fuzzy ranking can target nested command variants', () => {
  const ranked = rankTuiSlashMenuEntries(
    buildTuiSlashMenuEntries(),
    'approve ag',
  );

  expect(ranked[0]?.label).toBe('/approve agent [approval_id]');
});

function buildControllerHarness() {
  const operations: string[] = [];
  const output = {
    isTTY: true,
    columns: 80,
    write: (chunk: string) => {
      operations.push(`write:${chunk}`);
      return true;
    },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  const rl = {
    line: '/mo',
    cursor: 3,
    getCursorPos: vi.fn(() => ({
      cols: rl.cursor,
      rows: 0,
    })),
    _refreshLine: vi.fn(() => {
      operations.push('refresh');
    }),
    _ttyWrite: vi.fn((chunk: string) => {
      operations.push(`tty:${chunk}`);
      rl.line += chunk;
      rl.cursor = rl.line.length;
    }),
    on: vi.fn(),
  } as unknown as readline.Interface;

  const controller = new TuiSlashMenuController({
    rl,
    entries: buildTuiSlashMenuEntries(),
    palette: {
      reset: '',
      separator: '',
      marker: '',
      markerSelected: '',
      command: '',
      commandSelected: '',
      description: '',
      descriptionSelected: '',
    },
    output,
  });

  controller.install();
  controller.sync();
  operations.length = 0;

  return { controller, output, rl, operations };
}

test('clears the current menu before readline redraws typed input', () => {
  const { rl, operations } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('d', { name: 'd' });

  expect(operations.indexOf('tty:d')).toBeGreaterThan(
    operations.findIndex((entry) => entry.startsWith('write:')),
  );
});

test('clears the current menu before refreshing a completed selection', () => {
  const { rl, operations } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('\t', { name: 'tab' });

  expect(operations.indexOf('refresh')).toBeGreaterThan(
    operations.findIndex((entry) => entry.startsWith('write:')),
  );
});

test('accepted slash completions mark the submitted line for history suppression', () => {
  const { controller, rl } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('\t', { name: 'tab' });
  rl.line += 'set gpt-5';
  rl.cursor = rl.line.length;
  controller.sync();

  expect(controller.consumePendingHistorySuppression('/model set gpt-5')).toBe(
    true,
  );
  expect(controller.consumePendingHistorySuppression('/model set gpt-5')).toBe(
    false,
  );
});

test('history suppression clears when the accepted completion is abandoned', () => {
  const { controller, rl } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('\t', { name: 'tab' });
  rl.line = 'plain text';
  rl.cursor = rl.line.length;
  controller.sync();

  expect(controller.consumePendingHistorySuppression('plain text')).toBe(false);
});

test('restores the prompt cursor after rendering the menu', () => {
  const { controller, rl, operations } = buildControllerHarness();

  rl.line = '/mod';
  rl.cursor = rl.line.length;
  controller.sync();

  expect(operations.some((entry) => entry.includes('/model'))).toBe(true);
  expect(operations.at(-1)?.startsWith('write:\x1b[')).toBe(true);
});

test('escape dismisses the menu until the query changes', () => {
  const { controller, rl, operations } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'escape' });

  operations.length = 0;
  controller.sync();

  expect(operations.some((entry) => entry.includes('/model'))).toBe(false);

  rl.line = '/mod';
  rl.cursor = rl.line.length;
  controller.sync();

  expect(operations.some((entry) => entry.includes('/model'))).toBe(true);
});

test('second escape clears the current prompt line after dismissing the menu', () => {
  const { rl, operations } = buildControllerHarness();

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'escape' });

  operations.length = 0;
  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'escape' });

  expect(rl.line).toBe('');
  expect(rl.cursor).toBe(0);
  expect(operations).toContain('refresh');
});
