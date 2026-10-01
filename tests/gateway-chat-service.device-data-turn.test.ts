import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';

import type { ContainerOutput } from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-device-data-turn-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

const SUCCESS: ContainerOutput = {
  status: 'success',
  result: 'Done.',
  toolsUsed: [],
  toolExecutions: [],
};
const CALENDAR =
  'Calendar, next 7 days (Europe/Berlin):\n- Thu 1 Oct 09:00–10:00 Review';

// A request can name an instance the turn does not run in; the agent's tool
// call names the one it runs in.
test('the tool reads the user’s data when the turn moves to another instance', async () => {
  setupHome();
  const { DB_PATH } = await import('../src/config/config.js');
  const { createFreshSessionInstance, initDatabase } = await import(
    '../src/memory/db.js'
  );
  const { memoryService } = await import('../src/memory/memory-service.js');
  const device = await import('../src/gateway/device-data.js');
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  initDatabase({ quiet: true });
  device.writeDeviceSources('user_a', { calendar: CALENDAR });
  // An expired, superseded instance: its turn continues in the current one.
  memoryService.getOrCreateSession('web:phone', null, 'web');
  const current = createFreshSessionInstance('web:phone').session;
  const database = new Database(DB_PATH);
  try {
    database
      .prepare('UPDATE sessions SET last_active = ? WHERE id = ?')
      .run(
        new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString(),
        'web:phone',
      );
  } finally {
    database.close();
  }
  let read = '';
  runAgentMock.mockImplementation(async ({ sessionId }) => {
    read = device.renderDeviceDataForSession(sessionId, null);
    return SUCCESS;
  });

  const result = await handleGatewayMessage({
    sessionId: 'web:phone',
    guildId: null,
    channelId: 'web',
    userId: 'user_a',
    username: 'web',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    content: 'What is on my calendar?',
  });

  expect(result.sessionId).toBe(current.id);
  expect(runAgentMock.mock.calls[0]?.[0].sessionId).toBe(current.id);
  expect(read).toContain(CALENDAR);
  // Only while the turn runs.
  expect(device.renderDeviceDataForSession(current.id, null)).toContain(
    'shares nothing here',
  );
});
