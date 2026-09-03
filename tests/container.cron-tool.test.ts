import { afterEach, describe, expect, test } from 'vitest';

import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
  setGatewayContext,
  setScheduledTasks,
  setScheduleSideEffectsEnabled,
  validateCronExpression,
} from '../container/src/tools.js';

describe.sequential('container cron tool', () => {
  afterEach(() => {
    resetSideEffects();
    setScheduleSideEffectsEnabled(true);
    setScheduledTasks(undefined);
    setGatewayContext(undefined, undefined, '');
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

  test('blocks schedule creation when side effects are disabled', async () => {
    setScheduleSideEffectsEnabled(false);

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('scheduled task creation is disabled');
    expect(getPendingSideEffects()).toBeUndefined();
  });
  test('rejects malformed cron expressions instead of queueing them', async () => {
    for (const cron of ['9:00 daily', '0 0 9 * * *', '0 9 * * ?', '60 9 * * *']) {
      const result = await executeTool(
        'cron',
        JSON.stringify({ action: 'add', cron, prompt: 'Send the briefing.' }),
      );
      expect(result, cron).toContain('Error:');
    }
    expect(getPendingSideEffects()).toBeUndefined();
  });

  test('accepts standard cron expressions and marks them as UTC', async () => {
    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '30 6 * * mon-fri',
        channel: 'ops@example.com',
        prompt: 'Write the morning briefing.',
      }),
    );

    expect(result).toContain('(UTC)');
    expect(getPendingSideEffects()?.schedules).toEqual([
      {
        action: 'add',
        cronExpr: '30 6 * * mon-fri',
        channelId: 'ops@example.com',
        prompt: 'Write the morning briefing.',
      },
    ]);
  });

  test('requires an explicit delivery channel in web chat sessions', async () => {
    setGatewayContext(undefined, undefined, 'web');

    const withoutChannel = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 7 * * *',
        prompt: 'Write the morning briefing.',
      }),
    );
    expect(withoutChannel).toContain('Error:');
    expect(withoutChannel).toContain('"channel"');
    expect(getPendingSideEffects()).toBeUndefined();

    const withChannel = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 7 * * *',
        channel: 'ops@example.com',
        prompt: 'Write the morning briefing.',
      }),
    );
    expect(withChannel).toContain('Scheduled recurring task');
    expect(getPendingSideEffects()?.schedules).toHaveLength(1);
  });

  test('does not require a channel outside web chat sessions', async () => {
    setGatewayContext(undefined, undefined, '1234567890123456789');

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 7 * * *',
        prompt: 'Write the morning briefing.',
      }),
    );
    expect(result).toContain('Scheduled recurring task');
  });

  test('validateCronExpression covers ranges, lists, steps and names', () => {
    expect(validateCronExpression('*/15 8-18 * * 1-5')).toBeNull();
    expect(validateCronExpression('0 9,13 1 jan,jul *')).toBeNull();
    expect(validateCronExpression('0 9 * * sun')).toBeNull();
    expect(validateCronExpression('0 9 * jan-dec mon')).toBeNull();
    expect(validateCronExpression('0 25 * * *')).toContain('out of range');
    expect(validateCronExpression('0 9 * mon *')).toContain('not allowed');
    expect(validateCronExpression('0 9 * * *  extra')).toContain('exactly 5 fields');
  });
});
