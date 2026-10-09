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
