import { afterEach, describe, expect, test } from 'vitest';

import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
  setScheduledTasks,
} from '../container/src/tools.js';

describe.sequential('container cron tool', () => {
  afterEach(() => {
    resetSideEffects();
    setScheduledTasks(undefined);
  });

  test('accepts an explicit delivery channel when adding a task', async () => {
    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        channel: 'ops@example.com',
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('ops@example.com');
    expect(getPendingSideEffects()?.schedules).toEqual([
      {
        action: 'add',
        everyMs: 1_800_000,
        channelId: 'ops@example.com',
        prompt: 'Write a short operational update email.',
      },
    ]);
  });

  test('lists the delivery channel for injected scheduled tasks', async () => {
    setScheduledTasks([
      {
        id: 16,
        channelId: 'ops@example.com',
        cronExpr: '',
        runAt: null,
        everyMs: 1_800_000,
        prompt: 'Write a short operational update email.',
        enabled: 1,
        lastRun: null,
        createdAt: '2026-04-11T12:58:18.861Z',
      },
    ]);

    const result = await executeTool(
      'cron',
      JSON.stringify({ action: 'list' }),
    );

    expect(result).toContain('ops@example.com');
    expect(result).toContain('#16');
  });
});
