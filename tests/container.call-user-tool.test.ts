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
  // A named time or delay is a scheduled call, never one now, and asked.
  expect(description).toContain('never call now: add a one-shot cron task');
  expect(description).toContain('Set asked to true whenever the user requested the call');
  expect(description).toContain('the voice says the opening, then tells the notes');
});

test('the schema stays small enough to be offered directly, not behind tool_catalog', () => {
  // tool-catalog.ts keeps tools over 2,000 characters behind the catalog.
  expect(JSON.stringify(CALL_USER_TOOL_DEFINITION).length).toBeLessThanOrEqual(
    2000,
  );
});

test('with connector tools deferred, call_user is still offered directly', async () => {
  const { ToolCatalog } = await import('../container/src/tool-catalog.ts');
  const connector = {
    type: 'function' as const,
    function: {
      name: 'hybridai__mail__search',
      description: 'Search mail',
      parameters: { type: 'object' as const, properties: {}, required: [] },
    },
  };
  const catalog = ToolCatalog.deferring(
    [CALL_USER_TOOL_DEFINITION, connector],
    new Set([connector.function.name]),
    () => false,
  );
  expect(catalog?.tools.map((tool) => tool.function.name)).toEqual([
    'call_user',
    'tool_catalog',
  ]);
});
