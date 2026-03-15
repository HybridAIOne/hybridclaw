import { expect, test } from 'vitest';

import {
  buildTuiReadlineHistory,
  dropLatestTuiReadlineHistoryEntry,
  resolveTuiHistoryFetchLimit,
} from '../src/tui-history.js';

test('builds readline history from recent single-line user inputs', () => {
  const history = buildTuiReadlineHistory(
    [
      {
        id: 1,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '/status',
        created_at: '2026-03-14 10:00:00',
      },
      {
        id: 2,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'assistant',
        content: 'ok',
        created_at: '2026-03-14 10:00:01',
      },
      {
        id: 3,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '/model list',
        created_at: '2026-03-14 10:00:02',
      },
    ],
    10,
  );

  expect(history).toEqual(['/model list', '/status']);
});

test('drops blank and multiline user entries and respects the limit', () => {
  const history = buildTuiReadlineHistory(
    [
      {
        id: 1,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '   ',
        created_at: '2026-03-14 10:00:00',
      },
      {
        id: 2,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: 'first line\nsecond line',
        created_at: '2026-03-14 10:00:01',
      },
      {
        id: 3,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '/help',
        created_at: '2026-03-14 10:00:02',
      },
      {
        id: 4,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '/status',
        created_at: '2026-03-14 10:00:03',
      },
    ],
    1,
  );

  expect(history).toEqual(['/status']);
});

test('strips ANSI escape sequences before seeding readline history', () => {
  const history = buildTuiReadlineHistory(
    [
      {
        id: 1,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '\u001b[31m/status\u001b[0m',
        created_at: '2026-03-14 10:00:00',
      },
      {
        id: 2,
        session_id: 'tui:local',
        user_id: 'u1',
        username: 'user',
        role: 'user',
        content: '\u001b[2K\u001b[1A',
        created_at: '2026-03-14 10:00:01',
      },
    ],
    10,
  );

  expect(history).toEqual(['/status']);
});

test('over-fetches history to compensate for assistant turns', () => {
  expect(resolveTuiHistoryFetchLimit(1)).toBe(2);
  expect(resolveTuiHistoryFetchLimit(100)).toBe(200);
  expect(resolveTuiHistoryFetchLimit(150)).toBe(300);
  expect(resolveTuiHistoryFetchLimit(2000)).toBe(400);
});

test('drops only the newest readline history entry when it matches', () => {
  const history = ['/model set gpt-5', '/status'];

  dropLatestTuiReadlineHistoryEntry(history, '/model set gpt-5');

  expect(history).toEqual(['/status']);
});

test('leaves readline history untouched when the newest entry differs', () => {
  const history = ['/status', '/model set gpt-5'];

  dropLatestTuiReadlineHistoryEntry(history, '/model set gpt-5');

  expect(history).toEqual(['/status', '/model set gpt-5']);
});
