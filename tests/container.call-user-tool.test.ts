import { expect, test, vi } from 'vitest';

import {
  CALL_USER_TOOL_DEFINITION,
  runCallUserTool,
} from '../container/src/tools/call-user.ts';
import { useCleanMocks } from './test-utils.ts';

useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

const gateway = {
  baseUrl: 'http://gateway.example.com/',
  apiToken: 'test-key',
  sessionId: 'main-chat',
};

test('the tool asks the gateway to call on its own session and returns the outcome', async () => {
  const outcome = JSON.stringify({ status: 'missed', message: 'Write it.' });
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ ok: true, result: outcome })),
  );
  vi.stubGlobal('fetch', fetchMock);

  const answer = await runCallUserTool(
    { reason: 'Your 7:00 brief', asked: true, sessionId: 'someone-else', extra: 1 },
    gateway,
  );

  expect(answer).toEqual({ ok: true, text: outcome });
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://gateway.example.com/api/call-user');
  expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
  expect(JSON.parse(String(init.body))).toEqual({
    reason: 'Your 7:00 brief',
    asked: true,
    sessionId: 'main-chat',
  });
});

test('the schema asks for a reason and says when to call', () => {
  const { description, parameters } = CALL_USER_TOOL_DEFINITION.function;
  expect(parameters.required).toEqual(['reason']);
  expect(Object.keys(parameters.properties)).toEqual([
    'reason',
    'opening',
    'notes',
    'asked',
  ]);
  expect(description).toContain('asked to be called');
  expect(description).toContain('schedule a task');
});
