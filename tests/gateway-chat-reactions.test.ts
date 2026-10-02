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

function answered(result: string | null, emoji?: string): ContainerOutput {
  return {
    status: 'success',
    result,
    toolsUsed: emoji ? ['react'] : [],
    toolExecutions: emoji
      ? [
          {
            name: 'react',
            arguments: JSON.stringify({ emoji }),
            result: `Reacted with ${emoji}.`,
            durationMs: 1,
            isError: false,
          },
        ]
      : [],
  };
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
  const turn = (content: string, reactions = true) =>
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
      ...(reactions ? { reactions: true } : {}),
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

test('only a client that shows reactions gets the tool and the guidance', async () => {
  const { turn, sentToModel } = await setup();
  runAgentMock.mockResolvedValue(answered('Hello.'));

  await turn('hi', false);
  await turn('hi');

  expect(runAgentMock.mock.calls[0]?.[0].blockedTools).toContain('react');
  expect(sentToModel(0)).not.toContain('## Reactions');
  expect(runAgentMock.mock.calls[1]?.[0].blockedTools ?? []).not.toContain(
    'react',
  );
  expect(sentToModel(1)).toContain('## Reactions');
});

test('the agent’s reaction lands on the user’s message, and alone it is the whole answer', async () => {
  const { db, turn, getGatewayHistory } = await setup();
  runAgentMock
    .mockResolvedValueOnce(answered('Congratulations!', '🎉'))
    .mockResolvedValueOnce(answered(null, '❤️'));

  const first = await turn('I got the job!');
  const second = await turn('Thanks for your help');

  expect(first).toMatchObject({ result: 'Congratulations!', reaction: '🎉' });
  expect(second).toMatchObject({ result: '', reaction: '❤️' });
  const sessionId = String(first.sessionId);
  expect(
    getGatewayHistory(sessionId).history.map(
      ({ role, content, reaction }) => ({ role, content, reaction }),
    ),
  ).toEqual([
    { role: 'user', content: 'I got the job!', reaction: '🎉' },
    { role: 'assistant', content: 'Congratulations!', reaction: undefined },
    { role: 'user', content: 'Thanks for your help', reaction: '❤️' },
  ]);
  // Stored as a reply that says nothing, so the model never sees an empty turn.
  expect(db.getConversationHistory(sessionId, 1)[0]?.content).toBe(
    '__MESSAGE_SEND_HANDLED__',
  );
});

test('where reactions show, a reply of one emoji alone is a reaction', async () => {
  const { turn, getGatewayHistory } = await setup();
  runAgentMock
    .mockResolvedValueOnce(answered(' 😊\n'))
    .mockResolvedValueOnce(answered('😊 Gern!'))
    .mockResolvedValueOnce(answered('🎉🎉'))
    .mockResolvedValueOnce(answered('😊'));

  const lone = await turn('Supi!');
  const withText = await turn('Danke');
  const two = await turn('Bestanden!');
  const elsewhere = await turn('Super', false);

  expect(lone).toMatchObject({ result: '', reaction: '😊' });
  expect(withText).toMatchObject({ result: '😊 Gern!' });
  expect(withText.reaction).toBeUndefined();
  expect(two.reaction).toBeUndefined();
  expect(elsewhere).toMatchObject({ result: '😊' });
  expect(elsewhere.reaction).toBeUndefined();
  expect(
    getGatewayHistory(String(lone.sessionId)).history[0],
  ).toMatchObject({ role: 'user', content: 'Supi!', reaction: '😊' });
});

test('a message answered with a reaction alone reads as answered later', async () => {
  const { turn, sentToModel } = await setup();
  runAgentMock
    .mockResolvedValueOnce(answered(null, '🎉'))
    .mockResolvedValueOnce(answered('Any time!', '❤️'))
    .mockResolvedValueOnce(answered('Deep sleep restores the body.'));

  await turn('I got the job!');
  await turn('Thanks');
  await turn('What is deep sleep?');

  expect(sentToModel(1)).toContain('## Your Reactions');
  expect(sentToModel(2)).toContain('🎉 on \\"I got the job!\\"');
  // A reaction that came with words is in the history already.
  expect(sentToModel(2)).not.toContain('❤️ on');
});

test('a streamed reply is held back only while it could be one emoji alone', async () => {
  const { createLoneEmojiHold } = await import(
    '../src/gateway/chat-reactions.js'
  );
  const hold = createLoneEmojiHold();

  expect(hold.push('👍')).toBe('');
  expect(hold.push('🏽')).toBe('');
  expect(hold.flush()).toBe('👍🏽');
  // After a tool call, a new reply is held again.
  expect(hold.push('😊')).toBe('');
  expect(hold.push(' Gern')).toBe('😊 Gern');
  expect(hold.push('!')).toBe('!');
  expect(hold.flush()).toBe('');
  expect(hold.push('Hallo')).toBe('Hallo');
  expect(hold.push(' 🎉')).toBe(' 🎉');
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
  expect(sentToModel(2)).not.toContain('## Reactions From The User');
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
