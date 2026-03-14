import { expect, test } from 'vitest';

import { buildTuiReadlineHistory } from '../src/tui-history.js';

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
