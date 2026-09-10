import { afterEach, expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, fetchHybridAIAccountChatbotIdMock } = vi.hoisted(
  () => ({
    runAgentMock: vi.fn(),
    fetchHybridAIAccountChatbotIdMock: vi.fn(async () => 'bot-test'),
  }),
);

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/providers/hybridai-bots.js', async () => {
  const actual = await vi.importActual('../src/providers/hybridai-bots.ts');
  return {
    ...actual,
    fetchHybridAIAccountChatbotId: fetchHybridAIAccountChatbotIdMock,
  };
});

vi.mock('../src/plugins/plugin-manager.js', () => ({
  ensurePluginManagerInitialized: vi.fn(async () => null),
  reloadPluginManager: vi.fn(async () => null),
  setPluginInboundMessageDispatcher: vi.fn(),
  shutdownPluginManager: vi.fn(async () => {}),
  listLoadedPluginCommands: vi.fn(() => []),
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-in-flight-turns-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

afterEach(async () => {
  const { resetInFlightTurnsForTests } = await import(
    '../src/gateway/in-flight-turns.ts'
  );
  resetInFlightTurnsForTests();
});

test('in-flight turn counter tracks wrapped handlers until they settle', async () => {
  const { beginInFlightTurn, getInFlightTurnCount, withInFlightTurn } =
    await import('../src/gateway/in-flight-turns.ts');

  let finish: (() => void) | undefined;
  const handler = withInFlightTurn(
    (value: string) =>
      new Promise<string>((resolve) => {
        finish = () => resolve(value);
      }),
  );
  const pending = handler('done');
  expect(getInFlightTurnCount()).toBe(1);
  const release = beginInFlightTurn();
  expect(getInFlightTurnCount()).toBe(2);
  release();
  release();
  expect(getInFlightTurnCount()).toBe(1);
  finish?.();
  await expect(pending).resolves.toBe('done');
  expect(getInFlightTurnCount()).toBe(0);

  const failing = withInFlightTurn(async () => {
    throw new Error('boom');
  });
  await expect(failing()).rejects.toThrow('boom');
  expect(getInFlightTurnCount()).toBe(0);
});

test('handleGatewayMessage counts the turn and rejects new work while shutting down', async () => {
  setupHome();
  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });
  const { getInFlightTurnCount, markGatewayShuttingDown } = await import(
    '../src/gateway/in-flight-turns.ts'
  );
  const { GATEWAY_RESTARTING_ERROR, handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { formatChannelGatewayFailure } = await import(
    '../src/gateway/channel-gateway-failure.ts'
  );

  let observedDuringTurn = -1;
  runAgentMock.mockImplementation(async () => {
    observedDuringTurn = getInFlightTurnCount();
    return { status: 'success', result: 'ok', toolsUsed: [], artifacts: [] };
  });
  const result = await handleGatewayMessage({
    sessionId: 'session-in-flight',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: 'hello',
  });
  expect(result.status).toBe('success');
  expect(observedDuringTurn).toBe(1);
  expect(getInFlightTurnCount()).toBe(0);

  markGatewayShuttingDown();
  runAgentMock.mockClear();
  const rejected = await handleGatewayMessage({
    sessionId: 'session-in-flight',
    guildId: null,
    channelId: 'web',
    userId: 'user-1',
    username: 'User',
    content: 'again',
  });
  expect(rejected.status).toBe('error');
  expect(rejected.error).toBe(GATEWAY_RESTARTING_ERROR);
  expect(runAgentMock).not.toHaveBeenCalled();
  expect(formatChannelGatewayFailure(rejected.error)).toBe(
    GATEWAY_RESTARTING_ERROR,
  );
});
