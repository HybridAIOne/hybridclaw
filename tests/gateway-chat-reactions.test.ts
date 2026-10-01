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
