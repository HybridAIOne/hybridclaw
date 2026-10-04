import { expect, test, vi } from 'vitest';
import { runWorkTool } from '../container/src/tools/work.js';
import { useCleanMocks } from './test-utils.js';
useCleanMocks({ unstubAllGlobals: true });
test('the work tool sends the real session and preserves a gateway refusal', async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: false, error: 'Work not found.' }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const result = await runWorkTool({ action: 'get', id: 'run-1', sessionId: 'other' }, {
    baseUrl: 'http://gateway', apiToken: 'test-key', sessionId: 'current',
  });
  expect(result).toEqual({ ok: false, text: 'Error: Work not found.' });
  expect(fetch.mock.calls[0]?.[0]).toBe('http://gateway/api/work');
  const init = fetch.mock.calls[0]?.[1] as RequestInit;
  expect(JSON.parse(String(init.body))).toMatchObject({ sessionId: 'current', action: 'get', id: 'run-1' });
});
