import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
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
  tempHomePrefix: 'hybridclaw-chat-reactions-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

function answered(result: string | null): ContainerOutput {
  return { status: 'success', result, toolsUsed: [], toolExecutions: [] };
}

async function setup() {
  setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  const turn = (content: string) =>
    handleGatewayMessage({
      sessionId: 'web:phone',
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      username: 'web',
      model: 'hybridai/gpt-5-mini',
      chatbotId: 'bot_a',
      content,
      client: 'mobile',
    });
  const sentToModel = (call: number) =>
    JSON.stringify(runAgentMock.mock.calls[call]?.[0].messages);
  return { db, turn, getGatewayHistory, sentToModel };
}

function post(body: unknown): IncomingMessage {
  return Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as unknown as IncomingMessage;
}

function fakeResponse() {
  const res = {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    writeHead(status: number) {
      res.statusCode = status;
      return res;
    },
    end(chunk?: string) {
      res.body = chunk ?? '';
    },
  };
  return res;
}

test('main-model emoji text remains a reply and does not create a reaction', async () => {
  const { turn, getGatewayHistory, sentToModel } = await setup();
  runAgentMock.mockResolvedValue(answered('😊'));
  const result = await turn('Thanks');
  expect(result.result).toBe('😊');
  expect(result).not.toHaveProperty('reaction');
  expect(getGatewayHistory(String(result.sessionId)).history[0]?.reaction).toBeUndefined();
  expect(sentToModel(0)).not.toContain('## Reactions');
});

test('the bound phone persists or removes Hy’s quick reaction without rating a reply', async () => {
  const { turn, db } = await setup();
  runAgentMock.mockResolvedValue(answered('Congratulations!'));
  const result = await turn('I got the job!');
  const sessionId = String(result.sessionId);
  const store = await import('../src/gateway/web-notification-store.js');
  const { handleChatReactionRoute } = await import('../src/gateway/chat-reactions.js');
  const phone = store.notificationOperatorId('apiToken:phone');
  store.bindWebNotificationSession(sessionId, phone);
  const react = async (operator: string, body: Record<string, unknown>) => {
    const res = fakeResponse();
    await handleChatReactionRoute(post({ sessionId, messageId: result.userMessageId, role: 'user', ...body }),
      res as unknown as ServerResponse, operator, () => 'user_a');
    return res.statusCode;
  };
  expect(await react(phone, { emoji: '👍' })).toBe(200);
  expect(db.getConversationHistory(sessionId, 10).find(message => message.id === result.userMessageId)?.reaction).toBe('👍');
  expect(db.getResponseRatingsForMessages({ sessionId, messageIds: [Number(result.assistantMessageId)], operatorUserId: 'user_a' }).size).toBe(0);
  expect(await react('other', { emoji: '❤️' })).toBe(404);
  expect(await react(phone, { role: 'system', emoji: '❤️' })).toBe(400);
  expect(await react(phone, { role: 'assistant', emoji: '❤️' })).toBe(404);
  expect(await react(phone, { emoji: 'none' })).toBe(400);
  expect(await react(phone, { emoji: null })).toBe(200);
  expect(db.getConversationHistory(sessionId, 10).find(message => message.id === result.userMessageId)?.reaction).toBeNull();
});

test('the user’s reaction reaches the agent with their next message, once', async () => {
  const { turn, sentToModel } = await setup();
  runAgentMock.mockResolvedValue(answered('Here is your summary.'));
  const first = await turn('Sum up my week');
  const sessionId = String(first.sessionId);
  const store = await import('../src/gateway/web-notification-store.js');
  const { handleChatReactionRoute } = await import(
    '../src/gateway/chat-reactions.js'
  );
  const phone = store.notificationOperatorId('apiToken:phone');
  store.bindWebNotificationSession(sessionId, phone);
  const react = async (operatorId: string, body: Record<string, unknown>) => {
    const res = fakeResponse();
    await handleChatReactionRoute(
      post({ sessionId, messageId: first.assistantMessageId, ...body }),
      res as unknown as ServerResponse,
      operatorId,
      (userId) => userId || 'web',
    );
    return res.statusCode;
  };

  expect(await react(phone, { emoji: 'nice' })).toBe(400);
  expect(
    await react(store.notificationOperatorId('apiToken:other'), {
      emoji: '❤️',
    }),
  ).toBe(404);
  expect(
    await react(phone, { messageId: first.userMessageId, emoji: '❤️' }),
  ).toBe(404);
  expect(await react(phone, { emoji: '❤️' })).toBe(200);

  await turn('Thanks');
  await turn('What about next week?');

  expect(sentToModel(1)).toContain('## Reactions From The User');
  expect(sentToModel(1)).toContain('❤️ on \\"Here is your summary.\\"');
  // Later turns replay that context with its message; their own carries none.
  const currentContext = String(
    runAgentMock.mock.calls[2]?.[0].messages.at(-2)?.content,
  );
  expect(currentContext).toContain('<context>');
  expect(currentContext).not.toContain('## Reactions From The User');
});

test('a 👍 or 👎 on a reply is its rating, and only a withdrawn one clears it', async () => {
  const { db, turn } = await setup();
  runAgentMock.mockResolvedValue(answered('Here is your summary.'));
  const first = await turn('Sum up my week');
  const sessionId = String(first.sessionId);
  const messageId = Number(first.assistantMessageId);
  const store = await import('../src/gateway/web-notification-store.js');
  const { handleChatReactionRoute } = await import(
    '../src/gateway/chat-reactions.js'
  );
  const { submitResponseRating } = await import(
    '../src/gateway/response-ratings.js'
  );
  const phone = store.notificationOperatorId('apiToken:phone');
  store.bindWebNotificationSession(sessionId, phone);
  const react = async (emoji: string | null) => {
    const res = fakeResponse();
    await handleChatReactionRoute(
      post({ sessionId, messageId, emoji, userId: 'user_a' }),
      res as unknown as ServerResponse,
      phone,
      (userId) => userId || 'web',
    );
    expect(res.statusCode).toBe(200);
    return db
      .getResponseRatingsForMessages({
        sessionId,
        messageIds: [messageId],
        operatorUserId: 'user_a',
      })
      .get(messageId);
  };

  expect(await react('👍🏽')).toBe('up');
  expect(await react('👎')).toBe('down');
  expect(await react('❤️')).toBeUndefined();
  expect(await react('👍')).toBe('up');
  expect(await react(null)).toBeUndefined();
  // A rating given another way stays when an unrelated reaction comes off.
  submitResponseRating({
    sessionId,
    messageId,
    operatorUserId: 'user_a',
    rating: 'down',
  });
  expect(await react('😂')).toBe('down');
  expect(await react(null)).toBe('down');
});
