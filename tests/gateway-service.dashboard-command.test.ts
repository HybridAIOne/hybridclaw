import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({ runAgentMock: vi.fn() }));

vi.mock('../src/agent/agent.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/providers/hybridai-bots.js', async () => ({
  ...(await vi.importActual('../src/providers/hybridai-bots.ts')),
  fetchHybridAIAccountChatbotId: vi.fn(async () => 'bot-test'),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-dashboard-command-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const dashboard = {
  version: 1,
  id: 'post',
  title: 'Post diese Woche',
  updatedAt: '2026-10-01T08:00:00.000Z',
  panels: [
    {
      id: 'unread',
      kind: 'number',
      title: 'Ungelesen',
      value: 12,
      query: {
        source: 'Gmail',
        tools: [
          {
            name: 'hybridai__gmail__search_messages',
            args: { query: 'is:unread' },
          },
          // Named by mistake: a refresh never gets a tool that writes.
          { name: 'hybridai__gmail__send_message' },
        ],
        how: 'Ungelesene Mails im Posteingang',
      },
    },
  ],
};

async function load() {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const { agentWorkspaceDir } = await import('../src/infra/ipc.ts');
  initDatabase({ quiet: true });

  const send = async (text: string) => {
    const parsed = resolveTextChannelSlashCommands(text);
    expect(parsed).not.toBeNull();
    const result = await handleGatewayCommand({
      sessionId: 'app-dashboards',
      guildId: null,
      channelId: 'web',
      args: parsed?.[0] ?? [],
      userId: 'user_a',
    });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(result.text);
    } catch {}
    return { kind: result.kind, text: result.text, json };
  };
  const file = path.join(agentWorkspaceDir('main'), 'dashboards', 'post.json');
  return { send, file };
}

test('an app lists, shows and refreshes a dashboard with only its read tools', async () => {
  const { send, file } = await load();
  expect((await send('/dashboard list --json')).json).toEqual({
    version: 1,
    dashboards: [],
  });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(dashboard));
  expect((await send('/dashboard list --json')).json).toEqual({
    version: 1,
    dashboards: [
      {
        id: 'post',
        title: 'Post diese Woche',
        updatedAt: '2026-10-01T08:00:00.000Z',
        panels: 1,
        refreshing: false,
      },
    ],
  });
  expect((await send('/dashboard show post --json')).json).toEqual({
    version: 1,
    dashboard,
    refreshing: false,
  });

  // The run rewrites the file the way show_dashboard does.
  let finish = () => {};
  runAgentMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => {
          fs.writeFileSync(
            file,
            JSON.stringify({
              ...dashboard,
              updatedAt: new Date().toISOString(),
              panels: [{ ...dashboard.panels[0], value: 3 }],
            }),
          );
          resolve({ status: 'success', result: '', toolExecutions: [] });
        };
      }),
  );
  const started = await send('/dashboard refresh post --json');
  expect(started.json).toMatchObject({ version: 1, refreshing: true });
  // A second tap while it runs starts nothing.
  await send('/dashboard refresh post --json');
  expect(runAgentMock).toHaveBeenCalledTimes(1);
  const run = runAgentMock.mock.calls[0]?.[0];
  expect(run.allowedTools).toEqual([
    'hybridai__gmail__search_messages',
    'show_dashboard',
  ]);
  expect(run.sessionId).not.toBe('app-dashboards');
  expect(run.messages[0].content).toContain('id "post"');

  finish();
  await vi.waitFor(async () => {
    expect((await send('/dashboard show post --json')).json).toMatchObject({
      refreshing: false,
      dashboard: { panels: [{ value: 3 }] },
    });
  });
});

test('a refresh that writes nothing reports why', async () => {
  const { send, file } = await load();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(dashboard));
  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    error: 'Connector unavailable',
    toolExecutions: [],
  });

  await send('/dashboard refresh post --json');
  await vi.waitFor(async () => {
    expect((await send('/dashboard show post --json')).json).toMatchObject({
      refreshing: false,
      error: 'Connector unavailable',
      dashboard: { panels: [{ value: 12 }] },
    });
  });

  expect((await send('/dashboard refresh nothing --json')).kind).toBe('error');
});

test('a schedule refreshes a dashboard once its figures are older than the morning', async () => {
  const { send, file } = await load();
  const { dashboardRefreshDue, refreshDueDashboards } = await import(
    '../src/gateway/dashboard-command.ts'
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(dashboard));

  expect((await send('/dashboard schedule post hourly --json')).kind).toBe(
    'error',
  );
  expect((await send('/dashboard schedule post daily --json')).json).toMatchObject(
    { refresh: 'daily', dashboard: { id: 'post' } },
  );
  expect(
    ((await send('/dashboard list --json')).json.dashboards as unknown[])[0],
  ).toMatchObject({ id: 'post', refresh: 'daily' });

  runAgentMock.mockResolvedValue({
    status: 'error',
    result: null,
    error: 'Connector unavailable',
    toolExecutions: [],
  });
  // Figures from October 1 are older than this morning's 7:00.
  const morning = new Date('2026-10-09T08:00:00Z');
  const runner = vi.fn(async () => ({ error: 'Connector unavailable' }));
  expect(refreshDueDashboards(runner, morning)).toEqual(['main:post']);
  await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
  // A failed one waits an hour before it is tried again.
  expect(refreshDueDashboards(runner, morning)).toEqual([]);
  expect(
    refreshDueDashboards(runner, new Date(Date.now() + 61 * 60_000)),
  ).toEqual(['main:post']);

  expect((await send('/dashboard schedule post off --json')).json).not.toHaveProperty(
    'refresh',
  );
  expect(refreshDueDashboards(runner, new Date(Date.now() + 3 * 3600_000))).toEqual(
    [],
  );

  // Due: older than 7:00 on the day, or on the last Monday for weekly, in the
  // user's zone. 2026-10-09 is a Friday; 05:30Z is 07:30 in Berlin.
  const berlin = 'Europe/Berlin';
  const friday = new Date('2026-10-09T05:30:00Z');
  expect(dashboardRefreshDue('daily', '2026-10-09T04:00:00Z', friday, berlin)).toBe(true);
  expect(dashboardRefreshDue('daily', '2026-10-09T05:10:00Z', friday, berlin)).toBe(false);
  // Before 7 the last morning was yesterday's.
  const early = new Date('2026-10-09T04:30:00Z');
  expect(dashboardRefreshDue('daily', '2026-10-08T06:00:00Z', early, berlin)).toBe(false);
  expect(dashboardRefreshDue('weekly', '2026-10-05T06:00:00Z', friday, berlin)).toBe(false);
  expect(dashboardRefreshDue('weekly', '2026-10-05T04:00:00Z', friday, berlin)).toBe(true);
});
