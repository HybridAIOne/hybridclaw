import { expect, test, vi } from 'vitest';
import { runTrackedDraftEmailTool } from '../container/src/tools/draft-email.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });
const gateway = { baseUrl: 'http://gateway.example.com', apiToken: 'test-key', sessionId: 'current-chat' };
const draft = { from: 'pat@example.com', to: ['alex@example.com'], subject: 'Friday', body: 'See you then.', track_id: 1 };

test('a tracked draft validates the item through the authenticated tool session', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: 'Accessible' })));
  vi.stubGlobal('fetch', fetch);
  expect((await runTrackedDraftEmailTool({ ...draft, sessionId: 'forged', userId: 'other' }, gateway)).ok).toBe(true);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://gateway.example.com/api/track');
  expect(JSON.parse(String(init.body))).toEqual({ action: 'validate_draft', id: 1, sessionId: gateway.sessionId });
});

test('a missing item or malformed id cannot produce a successful tracked draft', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Goal was not found.' }), { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  expect((await runTrackedDraftEmailTool(draft, gateway)).ok).toBe(false);
  expect((await runTrackedDraftEmailTool({ ...draft, track_id: -1 }, gateway)).ok).toBe(false);
  expect(fetch).toHaveBeenCalledOnce();
});
