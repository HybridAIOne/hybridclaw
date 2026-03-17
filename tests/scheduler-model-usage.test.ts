import { expect, test } from 'vitest';

import { buildModelUsageAuditStats } from '../src/scheduler/model-usage.js';

test('buildModelUsageAuditStats falls back to estimated token counts', () => {
  const usage = buildModelUsageAuditStats({
    messages: [{ role: 'user', content: 'check the queue' }],
    resultText: 'all clear',
    toolCallCount: 2,
  });

  expect(usage.modelCalls).toBe(0);
  expect(usage.toolCallCount).toBe(2);
  expect(usage.apiUsageAvailable).toBe(false);
  expect(usage.promptTokens).toBe(usage.estimatedPromptTokens);
  expect(usage.completionTokens).toBe(usage.estimatedCompletionTokens);
  expect(usage.totalTokens).toBe(usage.estimatedTotalTokens);
  expect(usage.totalTokens).toBe(
    usage.estimatedPromptTokens + usage.estimatedCompletionTokens,
  );
  expect(usage.apiCacheUsageAvailable).toBe(false);
});

test('buildModelUsageAuditStats prefers API usage and cache counters when available', () => {
  const usage = buildModelUsageAuditStats({
    messages: [{ role: 'user', content: 'run the task' }],
    resultText: 'done',
    toolCallCount: 1,
    tokenUsage: {
      modelCalls: 0,
      apiUsageAvailable: true,
      apiPromptTokens: 11,
      apiCompletionTokens: 7,
      apiTotalTokens: 18,
      apiCacheUsageAvailable: true,
      apiCacheReadTokens: 5,
      apiCacheWriteTokens: 3,
      estimatedPromptTokens: 99,
      estimatedCompletionTokens: 88,
      estimatedTotalTokens: 187,
    },
  });

  expect(usage.modelCalls).toBe(1);
  expect(usage.promptTokens).toBe(11);
  expect(usage.completionTokens).toBe(7);
  expect(usage.totalTokens).toBe(18);
  expect(usage.apiCacheUsageAvailable).toBe(true);
  expect(usage.apiCacheReadTokens).toBe(5);
  expect(usage.apiCacheWriteTokens).toBe(3);
});
