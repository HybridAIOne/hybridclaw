import { expect, test, vi } from 'vitest';

import { setupGatewayTest } from './helpers/gateway-test-setup.js';
import { useCleanMocks } from './test-utils.js';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-thumbs-',
});

useCleanMocks({ unmock: ['../src/auth/hybridai-auth.js'] });

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.ts');
  const { handleGatewayCommand } = await import(
    '../src/gateway/gateway-service.ts'
  );
  db.initDatabase({ quiet: true });
  const session = db.getOrCreateSession(
    'agent:main:channel:msteams:chat:dm:peer:thumbs-user',
    null,
    'msteams-conversation',
    'main',
  );
  return { db, handleGatewayCommand, session };
}

test('thumbs command rates the latest assistant answer with a comment', async () => {
  const { db, handleGatewayCommand, session } = await setup();
  db.storeMessage(session.id, 'teams-user', 'Teams User', 'user', 'What is 100+100?');
  const assistantMessageId = db.storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'It is 300.',
    'main',
  );

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'msteams-conversation',
    userId: 'teams-user',
    username: 'Teams User',
    args: ['thumbs', 'down', 'Correct', 'answer', 'is:', '200'],
  });

  expect(result.kind).toBe('plain');
  expect(result.text).toContain('👎');
  expect(result.text).toContain('Correct answer is: 200');
  expect(
    db.getResponseRatingsForMessages({
      sessionId: session.id,
      messageIds: [assistantMessageId],
      operatorUserId: 'teams-user',
    }),
  ).toEqual(new Map([[assistantMessageId, 'down']]));
});

test('thumbs command supports up ratings and clearing them', async () => {
  const { db, handleGatewayCommand, session } = await setup();
  const assistantMessageId = db.storeMessage(
    session.id,
    'assistant',
    null,
    'assistant',
    'Answer.',
    'main',
  );

  const rated = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'msteams-conversation',
    userId: 'teams-user',
    username: 'Teams User',
    args: ['thumbs', 'up'],
  });
  expect(rated.kind).toBe('plain');
  expect(rated.text).toContain('👍');

  const cleared = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'msteams-conversation',
    userId: 'teams-user',
    username: 'Teams User',
    args: ['thumbs', 'clear'],
  });
  expect(cleared.kind).toBe('plain');
  expect(
    db.getResponseRatingsForMessages({
      sessionId: session.id,
      messageIds: [assistantMessageId],
      operatorUserId: 'teams-user',
    }),
  ).toEqual(new Map());
});

test('thumbs command rejects unknown subcommands and empty sessions', async () => {
  const { db, handleGatewayCommand, session } = await setup();

  const usage = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'msteams-conversation',
    userId: 'teams-user',
    username: 'Teams User',
    args: ['thumbs', 'sideways'],
  });
  expect(usage.kind).toBe('error');
  expect(usage.text).toContain('/thumbs up|down');

  db.storeMessage(session.id, 'teams-user', 'Teams User', 'user', 'Hello?');
  const nothingToRate = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'msteams-conversation',
    userId: 'teams-user',
    username: 'Teams User',
    args: ['thumbs', 'up'],
  });
  expect(nothingToRate.kind).toBe('error');
  expect(nothingToRate.title).toBe('Nothing To Rate');
});

test('thumbs command forwards a Teams rating under the member email', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
  vi.stubGlobal('fetch', fetchMock);
  vi.doMock('../src/auth/hybridai-auth.js', () => ({
    getHybridAIAuthStatus: () => ({ authenticated: true }),
    getHybridAIApiKey: () => 'test-key',
  }));
  const { db, handleGatewayCommand, session } = await setup();
  expect(session.id).toMatch(/^sess_/);
  db.updateSessionModel(session.id, 'hybridai/gpt-5');
  db.updateSessionChatbot(session.id, 'bot-teams');
  const { observeChannelUser } = await import(
    '../src/memory/channel-users.js'
  );
  observeChannelUser({
    channelKind: 'msteams',
    tenantId: 'tenant-a',
    userId: 'entra-pat',
    email: 'pat@example.com',
    isMessage: true,
  });
  db.storeMessage(session.id, 'assistant', null, 'assistant', 'Answer.', 'main');

  const result = await handleGatewayCommand({
    sessionId: session.id,
    guildId: null,
    channelId: 'a:1personal-example',
    userId: 'entra-pat',
    username: 'Pat',
    args: ['thumbs', 'up'],
  });

  expect(result.kind).toBe('plain');
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  const [, request] = fetchMock.mock.calls[0] as [
    string,
    RequestInit & { body: string },
  ];
  expect(JSON.parse(request.body)).toMatchObject({
    chatbot_id: 'bot-teams',
    rating: 'up',
    external_user_id: 'pat@example.com',
  });
});
