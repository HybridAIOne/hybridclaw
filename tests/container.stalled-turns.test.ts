import { describe, expect, test } from 'vitest';

import { advanceStalledTurnCount } from '../container/src/stalled-turns.js';

describe('container stalled turn budget', () => {
  test('resets after a turn with successful tool execution', () => {
    expect(
      advanceStalledTurnCount({
        current: 7,
        toolCalls: 3,
        successfulToolCalls: 1,
      }),
    ).toBe(0);
  });

  test('increments after a turn with only failed or blocked tools', () => {
    expect(
      advanceStalledTurnCount({
        current: 7,
        toolCalls: 3,
        successfulToolCalls: 0,
      }),
    ).toBe(8);
  });

  test('increments after a no-tool continuation turn', () => {
    expect(
      advanceStalledTurnCount({
        current: 2,
        toolCalls: 0,
        successfulToolCalls: 0,
      }),
    ).toBe(3);
  });
});
