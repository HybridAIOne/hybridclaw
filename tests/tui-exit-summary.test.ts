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

test('fetchTuiRemoteExitSummary retries remote fetches before returning an error', async () => {
  let attempts = 0;

  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => {
        attempts += 1;
        throw new Error('Gateway request failed');
      },
      retries: 2,
      retryDelayMs: 0,
    }),
  ).resolves.toEqual({
    summary: null,
    error: 'Gateway request failed',
  });
  expect(attempts).toBe(3);
});

test('fetchTuiRemoteExitSummary reports an empty remote history summary explicitly', async () => {
  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => null,
      retries: 0,
    }),
  ).resolves.toEqual({
    summary: null,
    error: 'Gateway history returned no summary.',
  });
});

test('fetchTuiRemoteExitSummary rejects remote summaries that have messages but no visible activity', async () => {
  await expect(
    fetchTuiRemoteExitSummary({
      loadRemote: async () => ({
        messageCount: 2,
        userMessageCount: 1,
        toolCallCount: 0,
        inputTokenCount: 0,
        outputTokenCount: 0,
        costUsd: 0,
        toolBreakdown: [],
        fileChanges: {
          readCount: 0,
          modifiedCount: 0,
          createdCount: 0,
          deletedCount: 0,
        },
      }),
      retries: 0,
    }),
  ).resolves.toEqual({
    summary: null,
    error: 'Gateway history returned an empty activity summary.',
  });
});
