import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  executeTool,
  getPendingSideEffects,
  resetSideEffects,
  setGatewayContext,
  setScheduledTasks,
  setScheduleSideEffectsEnabled,
  setSessionContext,
  validateCronExpression,
} from '../container/src/tools.js';

const GATEWAY_URL = 'http://gateway.test';
const ORIGINAL_FETCH = globalThis.fetch;

type FetchCall = { url: string; init: RequestInit };

function installGatewayFetch(
  respond: (
    call: FetchCall,
  ) => { status?: number; body: Record<string, unknown> } | Error = () => ({
    body: { ok: true, action: 'add', taskId: 42 },
  }),
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const outcome = respond(call);
    if (outcome instanceof Error) throw outcome;
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

function readRequestBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe.sequential('container cron tool', () => {
  beforeEach(() => {
    setGatewayContext(GATEWAY_URL, 'gateway-token', '1234567890123456789');
    setSessionContext('session-cron');
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    resetSideEffects();
    setScheduleSideEffectsEnabled(true);
    setScheduledTasks(undefined);
    setGatewayContext(undefined, undefined, '');
    setSessionContext('');
  });

  test('creates the job through the gateway and returns the persisted id', async () => {
    const calls = installGatewayFetch();

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        channel: 'ops@example.com',
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('Scheduled interval task #42');
    expect(result).toContain('ops@example.com');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${GATEWAY_URL}/api/scheduler/task`);
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe('Bearer gateway-token');
    expect(readRequestBody(calls[0])).toEqual({
      action: 'add',
      everyMs: 1_800_000,
      channelId: 'ops@example.com',
      prompt: 'Write a short operational update email.',
      sessionId: 'session-cron',
    });
    expect(getPendingSideEffects()).toBeUndefined();
  });

  test('falls back to the session channel when no explicit channel is given', async () => {
    const calls = installGatewayFetch();

    await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 7 * * *',
        prompt: 'Write the morning briefing.',
      }),
    );

    expect(readRequestBody(calls[0])).toMatchObject({
      cronExpr: '0 7 * * *',
      channelId: '1234567890123456789',
    });
  });

  test('reports a tool error when the gateway rejects the job', async () => {
    installGatewayFetch(() => ({
      status: 404,
      body: { error: 'Unknown session: session-cron' },
    }));

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('Error: scheduled task creation failed (HTTP 404)');
    expect(result).toContain('Unknown session: session-cron');
  });

  test('reports a tool error when the gateway is unreachable', async () => {
    installGatewayFetch(() => new Error('ECONNREFUSED'));

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('Error: scheduled task request failed');
    expect(result).toContain('ECONNREFUSED');
  });

  test('refuses to schedule without a configured gateway', async () => {
    const calls = installGatewayFetch();
    setGatewayContext(undefined, undefined, '1234567890123456789');

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        every: 1800,
        prompt: 'Write a short operational update email.',
      }),
    );

    expect(result).toContain('Error:');
    expect(result).toContain('gatewayBaseUrl is not configured');
    expect(calls).toHaveLength(0);
  });

  test('removes a task through the gateway', async () => {
    const calls = installGatewayFetch(() => ({
      body: { ok: true, action: 'remove', taskId: 16 },
    }));

    const result = await executeTool(
      'cron',
      JSON.stringify({ action: 'remove', taskId: 16 }),
    );

    expect(result).toBe('Removed task #16');
    expect(readRequestBody(calls[0])).toEqual({
      action: 'remove',
      taskId: 16,
      sessionId: 'session-cron',
    });
  });

  test('lists the delivery channel for injected scheduled tasks', async () => {
    setScheduledTasks([
      {
        id: 16,
        channelId: 'ops@example.com',
        cronExpr: '',
        tz: '',
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
    const calls = installGatewayFetch();
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
    expect(calls).toHaveLength(0);
  });

  test('rejects malformed cron expressions before calling the gateway', async () => {
    const calls = installGatewayFetch();
    for (const cron of ['9:00 daily', '0 0 9 * * *', '0 9 * * ?', '60 9 * * *']) {
      const result = await executeTool(
        'cron',
        JSON.stringify({ action: 'add', cron, prompt: 'Send the briefing.' }),
      );
      expect(result, cron).toContain('Error:');
    }
    expect(calls).toHaveLength(0);
  });

  test('falls back to UTC when no timezone is known', async () => {
    const calls = installGatewayFetch();

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
    expect(result).toContain('#42');
    expect(readRequestBody(calls[0])).toMatchObject({
      action: 'add',
      cronExpr: '30 6 * * mon-fri',
      channelId: 'ops@example.com',
      prompt: 'Write the morning briefing.',
    });
  });

  test('stores an explicit timezone with cron tasks', async () => {
    const calls = installGatewayFetch();

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 9 * * *',
        tz: 'Europe/Berlin',
        prompt: 'Write the morning briefing.',
      }),
    );

    expect(result).toContain('(Europe/Berlin)');
    expect(result).toContain('#42');
    expect(readRequestBody(calls[0])).toMatchObject({
      action: 'add',
      cronExpr: '0 9 * * *',
      tz: 'Europe/Berlin',
      prompt: 'Write the morning briefing.',
    });
  });

  test('rejects unknown timezones before calling the gateway', async () => {
    const calls = installGatewayFetch();

    const result = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 9 * * *',
        tz: 'Mars/Olympus',
        prompt: 'Write the morning briefing.',
      }),
    );

    expect(result).toContain('Error: unknown timezone');
    expect(calls).toHaveLength(0);
  });

  test('defaults the cron timezone to USER.md', async () => {
    const calls = installGatewayFetch();
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-cron-workspace-'),
    );
    try {
      fs.writeFileSync(
        path.join(workspaceRoot, 'USER.md'),
        '# User\n\n**Timezone:** America/New_York\n',
      );
      vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
      vi.resetModules();
      const tools = await import('../container/src/tools.js');
      tools.setGatewayContext(GATEWAY_URL, 'gateway-token', '1234567890123456789');
      tools.setSessionContext('session-cron');

      const result = await tools.executeTool(
        'cron',
        JSON.stringify({
          action: 'add',
          cron: '0 9 * * *',
          prompt: 'Write the morning briefing.',
        }),
      );

      expect(result).toContain('(America/New_York)');
      expect(readRequestBody(calls[0])).toMatchObject({
        action: 'add',
        cronExpr: '0 9 * * *',
        tz: 'America/New_York',
        prompt: 'Write the morning briefing.',
      });
      tools.setGatewayContext(undefined, undefined, '');
      tools.setSessionContext('');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test('lists the timezone of injected cron tasks', async () => {
    setScheduledTasks([
      {
        id: 17,
        channelId: '',
        cronExpr: '0 9 * * *',
        tz: 'Europe/Berlin',
        runAt: null,
        everyMs: null,
        prompt: 'Write the morning briefing.',
        enabled: 1,
        lastRun: null,
        createdAt: '2026-04-11T12:58:18.861Z',
      },
    ]);

    const result = await executeTool(
      'cron',
      JSON.stringify({ action: 'list' }),
    );

    expect(result).toContain('0 9 * * * (Europe/Berlin)');
  });

  test('requires an explicit delivery channel in web chat and heartbeat sessions', async () => {
    const calls = installGatewayFetch();

    for (const channel of ['web', 'heartbeat']) {
      setGatewayContext(GATEWAY_URL, 'gateway-token', channel);
      const withoutChannel = await executeTool(
        'cron',
        JSON.stringify({
          action: 'add',
          cron: '0 7 * * *',
          prompt: 'Write the morning briefing.',
        }),
      );
      expect(withoutChannel, channel).toContain('Error:');
      expect(withoutChannel, channel).toContain('"channel"');
    }
    expect(calls).toHaveLength(0);

    const withChannel = await executeTool(
      'cron',
      JSON.stringify({
        action: 'add',
        cron: '0 7 * * *',
        channel: 'ops@example.com',
        prompt: 'Write the morning briefing.',
      }),
    );
    expect(withChannel).toContain('Scheduled recurring task #42');
    expect(calls).toHaveLength(1);
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
