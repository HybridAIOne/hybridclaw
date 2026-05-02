import { expect, test } from 'vitest';

import {
  formatTuiTitledCommandBlock,
  formatTuiToolActivityLine,
  nextActiveDelegateToolCount,
  parseTuiSectionCards,
  renderTuiEvalResultsPanel,
  visibleTuiLength,
} from '../src/tui.ts';

function stripAnsi(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'),
    '',
  );
}

test('formats titled command blocks with the standard left gutter', () => {
  expect(
    formatTuiTitledCommandBlock(
      'Plugin Check',
      ['Plugin: demo-plugin', 'Directory: /tmp/demo-plugin'].join('\n'),
      80,
    ),
  ).toEqual([
    '  Plugin Check',
    '',
    '  Plugin: demo-plugin',
    '  Directory: /tmp/demo-plugin',
  ]);
});

test('tool activity line preserves emoji and leaves room for terminal repaint', () => {
  const line = formatTuiToolActivityLine({
    toolName: 'bash',
    preview:
      "run shell command `node -e \"try{require('google-auth-library'); console.log('ok')}\"`",
    columns: 40,
    frameIndex: 0,
  });
  const plain = stripAnsi(line);

  expect(plain).toContain('🪼');
  expect(plain).not.toContain('�');
  expect(visibleTuiLength(line)).toBeLessThanOrEqual(39);
});

test('tool activity width uses production wide and zero-width handling', () => {
  const line = formatTuiToolActivityLine({
    toolName: 'bash',
    preview: 'run shell command `printf "界é"`',
    columns: 28,
    frameIndex: 0,
  });

  expect(visibleTuiLength(line)).toBeLessThanOrEqual(27);
  expect(stripAnsi(line)).not.toContain('�');
});

test('reflows locomo variant tables to the live tui width without splitting rows', () => {
  const text = [
    '┌─ Variants So Far ─────────┐',
    '│ Variant                       HitRate  F1       C1       C2       C3       C4       C5      │',
    '│ --------------------------  -------  -------  -------  -------  -------  -------  ------- │',
    '│ cosine                       0.5560   0.0020   0.3160   0.6240   0.3450   0.6490   0.5280  │',
    '│ \x1b[30;103mcosine + porter + bm25    \x1b[0m  \x1b[30;103m0.8050*\x1b[0m  \x1b[93m0.0020 \x1b[0m  \x1b[30;103m0.5920*\x1b[0m  \x1b[30;103m0.8860*\x1b[0m  \x1b[93m0.4340 \x1b[0m  \x1b[30;103m0.8630*\x1b[0m  \x1b[30;103m0.8640*\x1b[0m │',
    '└────────────────────────────┘',
  ].join('\n');

  const rendered = renderTuiEvalResultsPanel(parseTuiSectionCards(text), 96);
  const joined = rendered.join('\n');
  const dataLine = rendered.find(
    (line) =>
      line.includes('cosine + porter + bm25') &&
      line.includes('0.8630*') &&
      line.includes('0.8640*'),
  );

  expect(joined).toContain('Variants So Far');
  expect(joined).toContain('cosine + porter + bm25');
  expect(joined).toContain('0.8630*');
  expect(joined).toContain('0.8640*');
  expect(dataLine).toBeTruthy();
});

test('delegate text suppression only remains active while delegate tools are in flight', () => {
  let activeCount = 0;

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'start',
  });
  expect(activeCount).toBe(1);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'bash',
    phase: 'start',
  });
  expect(activeCount).toBe(1);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'finish',
  });
  expect(activeCount).toBe(0);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'finish',
  });
  expect(activeCount).toBe(0);
});
