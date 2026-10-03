import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';

import {
  closedSteerInboxDirName,
  decodeSteerNote,
  steerInboxDirName,
} from '../container/shared/steer-inbox.js';
import type { ExecutorRequest } from '../src/agent/executor-types.js';
import type { ContainerOutput } from '../src/types/container.js';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const SESSION = 'web:phone';
const OPERATOR = 'op_a';
const SECRET = 'test-secret';

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-chat-steer-',
  cleanup: () => {
    runAgentMock.mockReset();
  },
});

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

async function setup() {
  const home = setupHome();
  const db = await import('../src/memory/db.js');
  db.initDatabase({ quiet: true });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.js'
  );
  const { getGatewayHistory } = await import(
    '../src/gateway/gateway-service.js'
  );
  const { handleChatSteerRoute } = await import(
    '../src/gateway/chat-steer-route.js'
  );
  const { bindWebNotificationSession } = await import(
    '../src/gateway/web-notification-store.js'
  );
  bindWebNotificationSession(SESSION, OPERATOR);
  const ipcDir = fs.mkdtempSync(path.join(home, 'ipc-'));

  const steer = async (
    body: unknown,
    operatorId: string | null = OPERATOR,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = fakeResponse();
    await handleChatSteerRoute(post(body), res as unknown as ServerResponse, operatorId);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };
  const turn = (content: string, source?: string) =>
    handleGatewayMessage({
      sessionId: SESSION,
      guildId: null,
      channelId: 'web',
      userId: 'user_a',
      username: 'web',
      model: 'hybridai/gpt-5-mini',
      chatbotId: 'bot_a',
      content,
      client: 'mobile',
      ...(source ? { source } : {}),
    });
  /** What the agent does with the inbox: opens it, and reads what landed. */
  const openInbox = (params: ExecutorRequest, requestId: string) => {
    params.steerInbox?.open({ ipcDir, requestId, authSecret: SECRET });
    const dir = path.join(ipcDir, steerInboxDirName(requestId));
    fs.mkdirSync(dir, { recursive: true });
    return {
      take: () =>
        fs
          .readdirSync(dir)
          .sort()
          .map((name) =>
            decodeSteerNote(
              SECRET,
              requestId,
              fs.readFileSync(path.join(dir, name), 'utf8'),
            ),
          ),
      close: () =>
        fs.renameSync(
          dir,
          path.join(ipcDir, closedSteerInboxDirName(requestId)),
        ),
    };
  };
  const history = () =>
    getGatewayHistory(SESSION).history.map((message) => [
      message.role,
      message.content,
    ]);
  return { turn, steer, openInbox, history };
}

function answered(result: string, steerNoteIds?: string[]): ContainerOutput {
  return {
    status: 'success',
    result,
    toolsUsed: [],
    toolExecutions: [],
    ...(steerNoteIds ? { steerNoteIds } : {}),
  };
}

test('a note sent while the turn runs reaches it and is stored after the user’s message', async () => {
  const { turn, steer, openInbox, history } = await setup();
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    const inbox = openInbox(params, 'req-1');
    await expect(
      steer({ sessionId: SESSION, content: '  also add milk ' }),
    ).resolves.toEqual({ status: 200, body: { accepted: true } });
    const notes = inbox.take();
    expect(notes.map((note) => note?.content)).toEqual(['also add milk']);
    return answered('Added eggs and milk.', [String(notes[0]?.id)]);
  });

  await turn('add eggs to the list');

  expect(history()).toEqual([
    ['user', 'add eggs to the list'],
    ['user', 'also add milk'],
    ['assistant', 'Added eggs and milk.'],
  ]);
  // The turn is over: the next note is the client's to send as a turn.
  await expect(
    steer({ sessionId: SESSION, content: 'and bread' }),
  ).resolves.toEqual({ status: 200, body: { accepted: false } });
});

test('a note the agent never showed the model is not stored', async () => {
  const { turn, steer, openInbox, history } = await setup();
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    openInbox(params, 'req-1');
    await steer({ sessionId: SESSION, content: 'also add milk' });
    // A forged id (the agent's output is not trusted) stores nothing either.
    return answered('Added eggs.', ['not-a-delivered-note']);
  });

  await turn('add eggs to the list');

  expect(history().map(([role]) => role)).toEqual(['user', 'assistant']);
});

test('once the agent has closed the inbox to finish, notes are refused', async () => {
  const { turn, steer, openInbox } = await setup();
  const results: unknown[] = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    const inbox = openInbox(params, 'req-1');
    inbox.close();
    results.push(
      (await steer({ sessionId: SESSION, content: 'too late' })).body,
    );
    return answered('Done.');
  });

  await turn('do it');

  expect(results).toEqual([{ accepted: false }]);
});

test('a later request of the same turn is offered the turn’s notes again', async () => {
  const { turn, steer, openInbox } = await setup();
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    const first = openInbox(params, 'req-1');
    await steer({ sessionId: SESSION, content: 'also add milk' });
    params.steerInbox?.close();
    expect(first.take).toThrow();
    // Model routing escalates: the next request starts from the turn's messages.
    const second = openInbox(params, 'req-2');
    expect(second.take().map((note) => note?.content)).toEqual([
      'also add milk',
    ]);
    return answered('Done.');
  });

  await turn('add eggs');

  expect(runAgentMock).toHaveBeenCalledTimes(1);
});

test.each([
  ['no session', { content: 'hi' }, 400],
  ['no content', { sessionId: SESSION, content: '   ' }, 400],
])('%s is a bad request', async (_name, body, status) => {
  const { steer } = await setup();
  expect((await steer(body)).status).toBe(status);
});

test.each([
  ['a command', { sessionId: SESSION, content: '/stop' }, OPERATOR],
  ['another caller’s session', { sessionId: SESSION, content: 'hi' }, 'op_b'],
  ['a caller with no identity', { sessionId: SESSION, content: 'hi' }, null],
  ['an unbound session', { sessionId: 'web:other', content: 'hi' }, OPERATOR],
])('%s is refused while a turn runs', async (_name, body, operatorId) => {
  const { turn, steer, openInbox } = await setup();
  const results: unknown[] = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    openInbox(params, 'req-1');
    results.push((await steer(body, operatorId)).body);
    return answered('Done.');
  });

  await turn('do it');

  expect(results).toEqual([{ accepted: false }]);
});

test('automatic turns take no notes', async () => {
  const { turn } = await setup();
  runAgentMock.mockResolvedValue(answered('Done.'));

  await turn('continue', 'fullauto');

  expect(runAgentMock.mock.calls[0]?.[0].steerInbox).toBeUndefined();
});

test('a stopped turn takes no more notes', async () => {
  const { turn, steer, openInbox } = await setup();
  const { interruptGatewaySessionExecution } = await import(
    '../src/gateway/gateway-request-runtime.js'
  );
  const results: unknown[] = [];
  runAgentMock.mockImplementation(async (params: ExecutorRequest) => {
    openInbox(params, 'req-1');
    interruptGatewaySessionExecution(SESSION);
    results.push((await steer({ sessionId: SESSION, content: 'hi' })).body);
    return { ...answered(''), status: 'error', error: 'Interrupted by user.' };
  });

  await turn('do it');

  expect(results).toEqual([{ accepted: false }]);
});

test('the inbox takes notes only while a request whose agent made it runs', async () => {
  const { SteerInbox } = await import('../src/infra/steer-inbox.js');
  const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-steer-ipc-'));
  try {
    const inbox = new SteerInbox();
    expect(inbox.deliver('early')).toBe(false);
    inbox.open({ ipcDir, requestId: 'req-1', authSecret: SECRET });
    // An agent without steering never makes its inbox: nothing is taken.
    expect(inbox.deliver('to an old agent')).toBe(false);
    fs.mkdirSync(path.join(ipcDir, steerInboxDirName('req-1')));
    expect(inbox.deliver('now')).toBe(true);
    inbox.close();
    expect(inbox.deliver('late')).toBe(false);
    expect(fs.readdirSync(ipcDir)).toEqual([]);
  } finally {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  }
});

test('a paired phone may steer: the route needs only what chatting needs', async () => {
  const rbac = await import('../src/security/admin-rbac.js');
  const grants = await import('../src/gateway/device-grants.js');
  const action = rbac.resolveAdminRbacAction('/api/chat/steer', 'POST');
  expect(action).toBe(rbac.resolveAdminRbacAction('/api/chat', 'POST'));
  expect(grants.DEVICE_TOKEN_ACTIONS).toContain(action);
});
