import { expect, test } from 'vitest';
import { buildContextUsageSnapshot } from '../src/gateway/context-usage.js';
import type { SessionStatusSnapshot } from '../src/gateway/gateway-session-status.js';

function makeStatus(
  overrides: Partial<SessionStatusSnapshot> = {},
): SessionStatusSnapshot {
  return {
    promptTokens: null,
    completionTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    cacheHitPercent: null,
    contextUsedTokens: null,
    contextBudgetTokens: null,
    contextUsagePercent: null,
    ...overrides,
  };
}

test('buildContextUsageSnapshot computes headroom and usage percent', () => {
  const snapshot = buildContextUsageSnapshot({
    sessionId: 'sess-1',
    model: 'anthropic/claude-4-opus',
    messageCount: 42,
    compactionCount: 2,
    modelContextWindowTokens: 200_000,
    statusSnapshot: makeStatus({
      contextUsedTokens: 50_000,
      contextBudgetTokens: 200_000,
      contextUsagePercent: 25,
      promptTokens: 45_000,
      completionTokens: 5_000,
    }),
  });
  expect(snapshot.sessionId).toBe('sess-1');
  expect(snapshot.model).toBe('anthropic/claude-4-opus');
  expect(snapshot.contextUsedTokens).toBe(50_000);
  expect(snapshot.contextBudgetTokens).toBe(200_000);
  expect(snapshot.contextUsagePercent).toBe(25);
  expect(snapshot.contextRemainingTokens).toBe(150_000);
  expect(snapshot.messageCount).toBe(42);
  expect(snapshot.compactionCount).toBe(2);
  expect(snapshot.promptTokens).toBe(45_000);
  expect(snapshot.completionTokens).toBe(5_000);
  expect(snapshot.compactionTokenBudget).toBeGreaterThan(0);
  expect(snapshot.compactionMessageThreshold).toBeGreaterThan(0);
  expect(snapshot.compactionKeepRecent).toBeGreaterThan(0);
});

test('buildContextUsageSnapshot leaves budget/headroom null when window unknown', () => {
  const snapshot = buildContextUsageSnapshot({
    sessionId: 'sess-2',
    model: 'custom/no-window',
    messageCount: 5,
    compactionCount: 0,
    modelContextWindowTokens: null,
    statusSnapshot: makeStatus({
      contextUsedTokens: 12_345,
      contextBudgetTokens: null,
      contextUsagePercent: null,
    }),
  });
  expect(snapshot.contextUsedTokens).toBe(12_345);
  expect(snapshot.contextBudgetTokens).toBeNull();
  expect(snapshot.contextUsagePercent).toBeNull();
  expect(snapshot.contextRemainingTokens).toBeNull();
});

test('buildContextUsageSnapshot clamps negative counts defensively', () => {
  const snapshot = buildContextUsageSnapshot({
    sessionId: 'sess-3',
    model: 'any',
    messageCount: -4,
    compactionCount: -2,
    modelContextWindowTokens: null,
    statusSnapshot: makeStatus(),
  });
  expect(snapshot.messageCount).toBe(0);
  expect(snapshot.compactionCount).toBe(0);
});

test('buildContextUsageSnapshot preserves counts beyond 32-bit range', () => {
  const huge = 2 ** 40;
  const snapshot = buildContextUsageSnapshot({
    sessionId: 'sess-4',
    model: 'any',
    messageCount: huge,
    compactionCount: huge + 5,
    modelContextWindowTokens: null,
    statusSnapshot: makeStatus(),
  });
  expect(snapshot.messageCount).toBe(huge);
  expect(snapshot.compactionCount).toBe(huge + 5);
});

test('buildContextUsageSnapshot tolerates non-finite counts', () => {
  const snapshot = buildContextUsageSnapshot({
    sessionId: 'sess-5',
    model: 'any',
    messageCount: Number.NaN,
    compactionCount: Number.POSITIVE_INFINITY,
    modelContextWindowTokens: null,
    statusSnapshot: makeStatus(),
  });
  expect(snapshot.messageCount).toBe(0);
  expect(snapshot.compactionCount).toBe(0);
});
