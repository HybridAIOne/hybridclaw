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
  expect(labels).toContain('/auth status hybridai');
  expect(labels).toContain('/secret list');
  expect(labels).toContain('/secret set <name> <value>');
  expect(labels).toContain('/config');
  expect(labels).toContain('/config check');
  expect(labels).toContain('/config reload');
  expect(labels).toContain('/config set <key> <value>');
  expect(labels.filter((label) => label === '/config')).toHaveLength(1);
  expect(labels).toContain('/approve yes [approval_id]');
  expect(labels).toContain('/fullauto on [prompt]');
  expect(labels).toContain('/bot list');
  expect(labels).toContain('/agent install <source>');
  expect(labels).toContain('/plugin install <path|npm-spec>');
  expect(labels).toContain('/plugin reinstall <path|npm-spec>');
  expect(labels).toContain('/skill');
  expect(labels).toContain('/skill config');
  expect(labels).toContain('/skill inspect <name>');
  expect(labels).toContain('/skill inspect --all');
  expect(labels).toContain('/skill runs <name>');
  expect(labels).toContain('/skill learn <name> --apply');
  expect(labels).toContain('/skill history <name>');
  expect(labels).toContain('/skill sync <source>');
  expect(labels).toContain('/skill import <source>');
  expect(labels).toContain('/skill import --force <source>');
});

test('does not duplicate concierge slash menu entries', () => {
  const labels = buildTuiSlashMenuEntries().map((entry) => entry.label);

  expect(labels.filter((label) => label === '/concierge info')).toHaveLength(1);
  expect(labels.filter((label) => label === '/concierge on')).toHaveLength(1);
  expect(labels.filter((label) => label === '/concierge off')).toHaveLength(1);
});

test('keeps /skill import visible in the base skill query results', () => {
  const ranked = rankTuiSlashMenuEntries(buildTuiSlashMenuEntries(), 'skill');

  expect(ranked.map((entry) => entry.label)).toContain(
    '/skill import <source>',
  );
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

test('includes plugin commands in slash menu results', () => {
  const entries = buildTuiSlashMenuEntries([
    {
      name: 'qmd',
      description: 'Show QMD plugin and index status',
    },
  ]);

  expect(entries.map((entry) => entry.label)).toContain('/qmd');
  expect(
    rankTuiSlashMenuEntries(entries, 'q').some(
      (entry) => entry.label === '/qmd',
    ),
  ).toBe(true);
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

test('arrow up falls through to readline history when slash query has no matches', () => {
  const { rl, operations } = buildControllerHarness();

  rl.line = '/mcp reconnect datalion';
  rl.cursor = rl.line.length;
  operations.length = 0;

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'up' });

  expect(operations).toContain('tty:');
});

test('arrow down falls through to readline history when slash query has no matches', () => {
  const { rl, operations } = buildControllerHarness();

  rl.line = '/mcp reconnect datalion';
  rl.cursor = rl.line.length;
  operations.length = 0;

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'down' });

  expect(operations).toContain('tty:');
});

test('arrow up falls through to readline history even when matches exist', () => {
  const { rl, operations } = buildControllerHarness();

  rl.line = '/mo';
  rl.cursor = rl.line.length;
  operations.length = 0;

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'up' });

  expect(operations).toContain('tty:');
});

test('ctrl-p still navigates slash menu entries when matches exist', () => {
  const { rl, operations } = buildControllerHarness();

  rl.line = '/mo';
  rl.cursor = rl.line.length;
  operations.length = 0;

  (
    rl as unknown as { _ttyWrite: (chunk: string, key: readline.Key) => void }
  )._ttyWrite('', { name: 'p', ctrl: true });

  expect(operations).not.toContain('tty:');
});
