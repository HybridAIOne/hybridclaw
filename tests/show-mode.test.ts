import { expect, test } from 'vitest';

import {
  sessionShowModeShowsActivity,
  sessionShowModeShowsThinking,
  sessionShowModeShowsTools,
} from '../src/gateway/show-mode.js';

test('show tools keeps generic activity visible without enabling thinking', () => {
  expect(sessionShowModeShowsActivity('tools')).toBe(true);
  expect(sessionShowModeShowsTools('tools')).toBe(true);
  expect(sessionShowModeShowsThinking('tools')).toBe(false);
});

test('show none hides both activity and tools', () => {
  expect(sessionShowModeShowsActivity('none')).toBe(false);
  expect(sessionShowModeShowsTools('none')).toBe(false);
  expect(sessionShowModeShowsThinking('none')).toBe(false);
});
