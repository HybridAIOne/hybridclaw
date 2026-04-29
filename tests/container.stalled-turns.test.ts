import { describe, expect, test } from 'vitest';

import {
  advanceStalledTurnCount,
  shouldRetryEmptyFinalResponse,
} from '../container/src/stalled-turns.js';

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

  test('retries empty final responses after tool use without artifacts', () => {
    expect(
      shouldRetryEmptyFinalResponse({
        visibleAssistantText: null,
        toolExecutionCount: 1,
        artifactCount: 0,
      }),
    ).toBe(true);
  });

  test('accepts final responses with text or artifacts', () => {
    expect(
      shouldRetryEmptyFinalResponse({
        visibleAssistantText: 'Done',
        toolExecutionCount: 1,
        artifactCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldRetryEmptyFinalResponse({
        visibleAssistantText: null,
        toolExecutionCount: 1,
        artifactCount: 1,
      }),
    ).toBe(false);
  });
});
