import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { fetchHybridAIBotsMock } = vi.hoisted(() => ({
  fetchHybridAIBotsMock: vi.fn(),
}));

vi.mock('../src/providers/hybridai-bots.ts', () => ({
  HybridAIBotFetchError: class HybridAIBotFetchError extends Error {},
  fetchHybridAIAccountChatbotId: vi.fn(async () => 'user-fallback'),
  fetchHybridAIBots: fetchHybridAIBotsMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-text-channel-bot-command-',
  cleanup: () => {
    fetchHybridAIBotsMock.mockReset();
  },
});

const SESSION_ID = 'session-text-bot-command';

async function runTextCommand(content: string) {
  setupHome();
  fetchHybridAIBotsMock.mockResolvedValue([
    { id: 'bot-research', name: 'Research Bot', model: '' },
  ]);
  const db = await import('../src/memory/db.ts');
  db.initDatabase({ quiet: true });
  db.getOrCreateSession(SESSION_ID, null, 'channel-text-bot-command');
  const { resolveTextChannelSlashCommands } = await import(
    '../src/gateway/text-channel-commands.ts'
  );
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );

  const commands = resolveTextChannelSlashCommands(content);
  expect(commands).toHaveLength(1);
  const result = await handleGatewayCommand({
    sessionId: SESSION_ID,
    guildId: null,
    channelId: 'channel-text-bot-command',
    args: commands?.[0] ?? [],
  });

  const { flushAuditTrail } = await import('../src/audit/audit-trail.ts');
  await flushAuditTrail();
  return {
    result,
    chatbotId: db.getSessionById(SESSION_ID)?.chatbot_id ?? null,
    auditTypes: db
      .getRecentStructuredAuditForSession(SESSION_ID, 20)
      .map((row) => row.event_type),
  };
}

test.each([
  '/bot research-bot',
  '/bot Research Bot',
])('%s answers with usage and keeps the session bot', async (content) => {
  const { result, chatbotId, auditTypes } = await runTextCommand(content);

  expect(result).toMatchObject({ kind: 'error', title: 'Usage' });
  expect(chatbotId).toBeNull();
  expect(auditTypes).not.toContain('bot.set');
  expect(fetchHybridAIBotsMock).not.toHaveBeenCalled();
});

test('/bot set selects the named bot for the session', async () => {
  const { result, chatbotId, auditTypes } = await runTextCommand(
    '/bot set Research Bot',
  );

  expect(result.kind).toBe('plain');
  expect(chatbotId).toBe('bot-research');
  expect(auditTypes).toContain('bot.set');
});
