import { expect, test } from 'vitest';

import { fetchTuiRemoteExitSummary } from '../src/tui-exit-summary.js';

const ACTIVE_SUMMARY = {
  messageCount: 6,
  userMessageCount: 3,
  toolCallCount: 2,
  inputTokenCount: 67_622,
  outputTokenCount: 355,
  costUsd: 0,
  toolBreakdown: [{ toolName: 'web_fetch', count: 2 }],
  fileChanges: {
    readCount: 0,
    modifiedCount: 0,
    createdCount: 0,
    deletedCount: 0,
  },
} as const;

test('fetchTuiRemoteExitSummary returns the remote summary when available', async () => {
  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => ACTIVE_SUMMARY,
    }),
  ).resolves.toEqual({
    summary: ACTIVE_SUMMARY,
    error: null,
  });
});

test('fetchTuiRemoteExitSummary returns the gateway error when the fetch fails', async () => {
  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => {
        throw new Error('Gateway request failed');
      },
    }),
  ).resolves.toEqual({
    summary: null,
    error: 'Gateway request failed',
  });
});

test('fetchTuiRemoteExitSummary reports an empty remote history summary explicitly', async () => {
  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => null,
    }),
  ).resolves.toEqual({
    summary: null,
    error: 'Gateway history returned no summary.',
  });
});
