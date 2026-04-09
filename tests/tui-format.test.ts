import { expect, test } from 'vitest';

import { formatTuiTitledCommandBlock } from '../src/tui.ts';

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
