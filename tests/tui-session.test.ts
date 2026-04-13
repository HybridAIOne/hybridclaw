import { expect, test } from 'vitest';

import {
  buildTuiExitSummaryLines,
  buildTuiUnavailableExitSummaryLines,
  formatTuiSessionDuration,
  generateTuiSessionId,
  resolveTuiRunOptions,
} from '../src/tui-session.js';

test('generateTuiSessionId uses a hermes-style timestamp and short hex suffix', () => {
  const sessionId = generateTuiSessionId(
    new Date(2026, 2, 16, 12, 22, 38),
    '532f05',
  );

  expect(sessionId).toBe(
    'agent:main:channel:tui:chat:dm:peer:20260316_122238_532f05',
  );
});

test('resolveTuiRunOptions preserves explicit resume session ids', () => {
  const now = new Date(2026, 2, 16, 12, 22, 38);

  expect(
    resolveTuiRunOptions({
      resumeSessionId: '20260316_122238_532f05',
      now,
    }),
  ).toEqual({
    sessionId: '20260316_122238_532f05',
    sessionMode: 'resume',
    startedAtMs: now.getTime(),
    resumeCommand: 'hybridclaw tui --resume',
  });
});

test('resolveTuiRunOptions marks fresh launches as new sessions', () => {
  const now = new Date(2026, 2, 16, 12, 22, 38);

  expect(
    resolveTuiRunOptions({ now, resumeCommand: 'hybridclaw tui --resume' }),
  ).toMatchObject({
    sessionMode: 'new',
    startedAtMs: now.getTime(),
    resumeCommand: 'hybridclaw tui --resume',
  });
});

test('buildTuiExitSummaryLines formats the session summary block', () => {
  expect(
    buildTuiExitSummaryLines({
      sessionId: '20260316_122238_532f05',
      durationMs: 461_000,
      inputTokenCount: 12_847,
      outputTokenCount: 8_203,
      costUsd: 0.42,
      toolCallCount: 23,
      toolBreakdown: [
        { toolName: 'edit', count: 14 },
        { toolName: 'bash', count: 6 },
        { toolName: 'read', count: 3 },
      ],
      readFileCount: 3,
      modifiedFileCount: 7,
      createdFileCount: 2,
      deletedFileCount: 1,
      resumeCommand: 'hybridclaw tui --resume',
    }),
  ).toEqual([
    'Session 20260316_122238_532f05 completed in 7m 41s',
    '',
    'Tokens:     12,847 in / 8,203 out  (~$0.42)',
    'Tool calls: 23 (14 edit, 6 bash, 3 read)',
    'Files:      3 read, 7 modified, 2 created, 1 deleted',
    '',
    'Resume: hybridclaw tui --resume 20260316_122238_532f05',
  ]);
});

test('buildTuiUnavailableExitSummaryLines formats the unavailable summary block', () => {
  expect(
    buildTuiUnavailableExitSummaryLines({
      sessionId: '20260316_122238_532f05',
      durationMs: 461_000,
      error: 'Gateway history returned no summary.',
      resumeCommand: 'hybridclaw tui --resume',
    }),
  ).toEqual([
    'Session 20260316_122238_532f05 completed in 7m 41s',
    '',
    'Summary:    unavailable (Gateway history returned no summary.)',
    '',
    'Resume: hybridclaw tui --resume 20260316_122238_532f05',
  ]);
});

test('formatTuiSessionDuration includes hours when needed', () => {
  expect(formatTuiSessionDuration(3_723_000)).toBe('1h 2m 3s');
});
