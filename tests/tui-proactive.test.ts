import { expect, test } from 'vitest';

import {
  normalizeGoalContinuationText,
  proactiveBadgeLabel,
  proactiveInlineLabel,
  proactiveSourceSuffix,
} from '../src/tui-proactive.js';

test('uses fullauto badge for full-auto proactive messages', () => {
  expect(proactiveBadgeLabel('fullauto')).toBe('fullauto');
  expect(proactiveSourceSuffix('fullauto')).toBe('');
  expect(proactiveBadgeLabel('fullauto:queued')).toBe('fullauto');
  expect(proactiveSourceSuffix('fullauto:queued')).toBe('');
});

test('suppresses reminder chrome for eval proactive messages', () => {
  expect(proactiveBadgeLabel('eval')).toBe('eval');
  expect(proactiveSourceSuffix('eval')).toBe('');
  expect(proactiveBadgeLabel('eval:queued')).toBe('eval');
  expect(proactiveSourceSuffix('eval:queued')).toBe('');
});

test('uses delegate badge for delegation proactive messages', () => {
  expect(proactiveBadgeLabel('delegate')).toBe('delegate');
  expect(proactiveSourceSuffix('delegate')).toBe('');
});

test('uses delegate badge for queued delegation proactive messages', () => {
  expect(proactiveBadgeLabel('delegate:queued')).toBe('delegate');
  expect(proactiveSourceSuffix('delegate:queued')).toBe('');
});

test('uses goal badge for standing goal continuations', () => {
  expect(proactiveBadgeLabel('goal-continuation')).toBe('goal');
  expect(proactiveInlineLabel('goal-continuation')).toBeNull();
  expect(proactiveSourceSuffix('goal-continuation')).toBe('');
});

test('uses goal badge for queued standing goal continuations', () => {
  expect(proactiveBadgeLabel('goal-continuation:queued')).toBe('goal');
  expect(proactiveInlineLabel('goal-continuation:queued')).toBeNull();
  expect(proactiveSourceSuffix('goal-continuation:queued')).toBe('');
});

test('normalizes goal continuation output spacing', () => {
  expect(normalizeGoalContinuationText('\n\n3 🦞\n\n\n4 🪼\n\n')).toBe(
    '3 🦞\n4 🪼',
  );
});

test('suppresses reminder chrome for scheduler config job outputs', () => {
  expect(proactiveBadgeLabel('schedule-job:release-brief')).toBeNull();
  expect(proactiveSourceSuffix('schedule-job:release-brief')).toBe('');
});

test('uses reminder badge only for scheduled reminders', () => {
  expect(proactiveBadgeLabel('schedule:12')).toBe('reminder');
  expect(proactiveSourceSuffix('schedule:12')).toBe('(schedule:12)');
  expect(proactiveBadgeLabel('schedule:12:queued')).toBe('reminder');
  expect(proactiveSourceSuffix('schedule:12:queued')).toBe(
    '(schedule:12:queued)',
  );
});

test('uses neutral badges for non-reminder proactive sources', () => {
  expect(proactiveBadgeLabel('heartbeat')).toBe('heartbeat');
  expect(proactiveInlineLabel('heartbeat')).toBeNull();
  expect(proactiveSourceSuffix('heartbeat')).toBe('');
  expect(proactiveBadgeLabel('custom-source')).toBe('proactive');
  expect(proactiveSourceSuffix('custom-source')).toBe('(custom-source)');
  expect(proactiveBadgeLabel(null)).toBe('proactive');
  expect(proactiveSourceSuffix(null)).toBe('');
});
