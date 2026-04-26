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
  expect(proactiveBadgeLabel('eval')).toBe('eval');
  expect(proactiveSourceSuffix('eval')).toBe('');
});

test('uses delegate badge for delegation proactive messages', () => {
  expect(proactiveBadgeLabel('delegate')).toBe('delegate');
  expect(proactiveSourceSuffix('delegate')).toBe('');
});

test('uses delegate badge for queued delegation proactive messages', () => {
  expect(proactiveBadgeLabel('delegate:queued')).toBe('delegate');
  expect(proactiveSourceSuffix('delegate:queued')).toBe('');
});

test('suppresses reminder chrome for scheduler config job outputs', () => {
  expect(proactiveBadgeLabel('schedule-job:release-brief')).toBeNull();
  expect(proactiveSourceSuffix('schedule-job:release-brief')).toBe('');
});

test('keeps reminder badge for other proactive sources', () => {
  expect(proactiveBadgeLabel('schedule:12')).toBe('reminder');
  expect(proactiveSourceSuffix('schedule:12')).toBe('(schedule:12)');
});
