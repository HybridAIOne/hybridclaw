import { expect, test, vi } from 'vitest';
import { setupGatewayTest } from './helpers/gateway-test-setup.js';

const { runAgentMock, callAuxiliaryModelMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  callAuxiliaryModelMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

vi.mock('../src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: callAuxiliaryModelMock,
}));

const { setupHome } = setupGatewayTest({
  tempHomePrefix: 'hybridclaw-gateway-session-title-',
  cleanup: () => {
    runAgentMock.mockReset();
    callAuxiliaryModelMock.mockReset();
  },
});

const REPLY = {
  status: 'success',
  result: 'Here is a plan for Friday.',
  toolsUsed: [],
  toolExecutions: [],
};

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A title call the test finishes by hand; other auxiliary calls answer empty. */
function holdTitle(): (title: string) => void {
  let finish: (title: string) => void = () => {};
  const pending = new Promise<{ provider: string; model: string; content: string }>(
    (resolve) => {
      finish = (content) =>
        resolve({ provider: 'hybridai', model: 'auxiliary/test', content });
    },
  );
  callAuxiliaryModelMock.mockImplementation(async (params: { task: string }) =>
    params.task === 'session_title'
      ? pending
      : { provider: 'hybridai', model: 'auxiliary/test', content: '' },
  );
  return finish;
}

async function loadGateway() {
  const { initDatabase, getSessionById } = await import('../src/memory/db.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  initDatabase({ quiet: true });
  updateRuntimeConfig((draft) => {
    draft.local.backends.lmstudio.enabled = true;
    draft.routing.enabled = false;
  });
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const sessionId = 'session-title-first-turn';
  return {
    sessionId,
    storedTitle: () => getSessionById(sessionId)?.title ?? null,
    send: (content: string) =>
      handleGatewayMessage({
        sessionId,
        guildId: null,
        channelId: 'web',
        userId: 'user_a',
        username: 'alice',
        content,
        model: 'lmstudio/test-model',
      }),
  };
}

test('the first reply carries the title when it is ready first', async () => {
  setupHome();
  const finishTitle = holdTitle();
  // The title is ready while the model is still writing the reply.
  runAgentMock.mockImplementation(async () => {
    finishTitle('Weekend Trip Plan');
    await flushMicrotasks();
    return REPLY;
  });
  const gateway = await loadGateway();

  const result = await gateway.send('Plan a weekend trip for Friday.');

  expect(result.status).toBe('success');
  expect(result.sessionTitle).toBe('Weekend Trip Plan');
  await flushMicrotasks();
  expect(gateway.storedTitle()).toBe('Weekend Trip Plan');
});

test('the first reply does not wait for a title that is not ready', async () => {
  setupHome();
  const finishTitle = holdTitle();
  runAgentMock.mockResolvedValue(REPLY);
  const gateway = await loadGateway();

  // Resolves although the title call is still open.
  const result = await gateway.send('Plan a weekend trip for Friday.');

  expect(result.status).toBe('success');
  expect(result).not.toHaveProperty('sessionTitle');
  expect(gateway.storedTitle()).toBeNull();

  finishTitle('Weekend Trip Plan');
  await flushMicrotasks();
  expect(gateway.storedTitle()).toBe('Weekend Trip Plan');
});

test('a failed first turn stores no title', async () => {
  setupHome();
  const finishTitle = holdTitle();
  runAgentMock.mockImplementation(async () => {
    finishTitle('Weekend Trip Plan');
    await flushMicrotasks();
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'Provider returned HTTP 503',
    };
  });
  const gateway = await loadGateway();

  const result = await gateway.send('Plan a weekend trip for Friday.');
  await flushMicrotasks();

  expect(result.status).toBe('error');
  expect(result).not.toHaveProperty('sessionTitle');
  expect(gateway.storedTitle()).toBeNull();
});

test('later turns ask for no title', async () => {
  setupHome();
  holdTitle();
  runAgentMock.mockResolvedValue(REPLY);
  const gateway = await loadGateway();

  await gateway.send('Plan a weekend trip for Friday.');
  const titleCalls = () =>
    callAuxiliaryModelMock.mock.calls.filter(
      ([params]) => params.task === 'session_title',
    ).length;
  expect(titleCalls()).toBe(1);

  const second = await gateway.send('Add a museum on Saturday.');
  expect(second).not.toHaveProperty('sessionTitle');
  expect(titleCalls()).toBe(1);
});
