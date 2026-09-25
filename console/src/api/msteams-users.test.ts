/**
 * Teams user requests preserve authenticated object payloads through the client.
 * Unlike component tests, these exercise JSON serialization; no gateway is called.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { fetchMSTeamsUsers, saveMSTeamsUserAgent } from './client';

afterEach(() => vi.unstubAllGlobals());

test('Teams user mappings send an authenticated JSON object and support clearing', async () => {
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify({ users: [], defaultAgentId: 'main' }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await fetchMSTeamsUsers('test-token');
  await saveMSTeamsUserAgent('test-token', 'user-a', 'sales');
  await saveMSTeamsUserAgent('test-token', 'user-a', null);
  expect(fetchMock).toHaveBeenNthCalledWith(
    1,
    '/api/admin/msteams/users',
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    }),
  );
  for (const [index, agentId] of [
    [1, 'sales'],
    [2, null],
  ] as const) {
    const options = fetchMock.mock.calls[index]?.[1] as RequestInit;
    expect(options.method).toBe('PUT');
    expect(JSON.parse(String(options.body))).toEqual({
      userId: 'user-a',
      agentId,
    });
  }
});
