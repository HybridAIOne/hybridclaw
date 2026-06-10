import { expect, test } from 'vitest';

import type { GatewayChatResult } from '../src/gateway/gateway-types.js';
import {
  filterGatewayChatResultForSessionShowMode,
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

// The web console relies on messageRole to render slash-command output as a
// distinct console block. The show-mode filter is the one transform this value
// passes through before it is streamed, so it must survive in every mode.
test('preserves the message role in every show mode', () => {
  const result: GatewayChatResult = {
    status: 'success',
    result: 'Session model set to `opus`.',
    toolsUsed: [],
    messageRole: 'command',
  };

  expect(
    filterGatewayChatResultForSessionShowMode(result, 'tools').messageRole,
  ).toBe('command');
  expect(
    filterGatewayChatResultForSessionShowMode(result, 'none').messageRole,
  ).toBe('command');
});
