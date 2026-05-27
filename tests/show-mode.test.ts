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

// The web console relies on `commandResult` to render slash-command output as a
// distinct console block. The show-mode filter is the one transform this flag
// passes through before it is streamed, so it must survive in every mode —
// both the tools-visible pass-through and the tools-hidden rewrite path.
test('preserves the commandResult flag in every show mode', () => {
  const result: GatewayChatResult = {
    status: 'success',
    result: 'Session model set to `opus`.',
    toolsUsed: [],
    commandResult: true,
  };

  expect(
    filterGatewayChatResultForSessionShowMode(result, 'tools').commandResult,
  ).toBe(true);
  expect(
    filterGatewayChatResultForSessionShowMode(result, 'none').commandResult,
  ).toBe(true);
});
