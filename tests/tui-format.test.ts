import { expect, test } from 'vitest';

import {
  formatTuiTitledCommandBlock,
  parseTuiSectionCards,
  renderTuiEvalResultsPanel,
} from '../src/tui.ts';

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
