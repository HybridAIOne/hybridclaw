import { expect, test, vi } from 'vitest';

import { runTodoTool } from '../container/src/tools/todo.ts';
import { useCleanMocks } from './test-utils.ts';

useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

const gateway = {
  baseUrl: 'http://gateway.example.com/',
  apiToken: 'test-key',
  sessionId: 'app-chat',
};

test('the tool asks the gateway on its own session and returns the answer', async () => {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true, result: 'Checked off #1' })),
  );
  vi.stubGlobal('fetch', fetchMock);

  const answer = await runTodoTool(
    { action: 'done', id: 1, sessionId: 'someone-else' },
    gateway,
  );

  expect(answer).toEqual({ ok: true, text: 'Checked off #1' });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe('http://gateway.example.com/api/todo');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
  expect(JSON.parse(String(init.body))).toEqual({
    action: 'done',
    id: 1,
    sessionId: 'app-chat',
  });
});

test.each([
  [
    new Response(JSON.stringify({ error: 'Todo #9 was not found.' }), {
      status: 400,
    }),
    'Error: Todo #9 was not found.',
  ],
  [new Response('bad gateway', { status: 502 }), 'Error: bad gateway'],
])('a refused request is a failed tool call', async (response, text) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response),
  );
  expect(await runTodoTool({ action: 'done', id: 9 }, gateway)).toEqual({
    ok: false,
    text,
  });
});

test('without a gateway the tool fails instead of guessing', async () => {
  expect(
    await runTodoTool({ action: 'list' }, { ...gateway, baseUrl: '' }),
  ).toMatchObject({ ok: false });
});
