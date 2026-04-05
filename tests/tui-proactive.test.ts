import { expect, test } from 'vitest';

import {
  proactiveBadgeLabel,
  proactiveSourceSuffix,
} from '../src/tui-proactive.js';

test('uses fullauto badge for full-auto proactive messages', () => {
  expect(proactiveBadgeLabel('fullauto')).toBe('fullauto');
  expect(proactiveSourceSuffix('fullauto')).toBe('');
});

test('leaves non-fullauto proactive messages unbadged', () => {
  expect(proactiveBadgeLabel('schedule:12')).toBeNull();
  expect(proactiveSourceSuffix('schedule:12')).toBe('(schedule:12)');
});

test('suppresses command source suffixes for queued command progress', () => {
  expect(proactiveBadgeLabel('command:eval')).toBeNull();
  expect(proactiveSourceSuffix('command:eval')).toBe('');
});
