import { expect, test } from 'vitest';

import {
  proactiveBadgeLabel,
  proactiveSourceSuffix,
} from '../src/tui-proactive.js';

test('uses fullauto badge for full-auto proactive messages', () => {
  expect(proactiveBadgeLabel('fullauto')).toBe('fullauto');
  expect(proactiveSourceSuffix('fullauto')).toBe('');
});

test('suppresses reminder chrome for eval proactive messages', () => {
  expect(proactiveBadgeLabel('eval')).toBeNull();
  expect(proactiveSourceSuffix('eval')).toBe('');
});

test('keeps reminder badge for other proactive sources', () => {
  expect(proactiveBadgeLabel('schedule:12')).toBe('reminder');
  expect(proactiveSourceSuffix('schedule:12')).toBe('(schedule:12)');
});
