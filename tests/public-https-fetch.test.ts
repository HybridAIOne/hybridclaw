import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:dns/promises');
  vi.doUnmock('node:https');
  vi.resetModules();
});

async function loadWithNetworkMocks(answers: Array<{ address: string; family: 4 | 6 }>) {
  const requestMock = vi.fn();
  const lookupMock = vi.fn(async () => answers);
  vi.doMock('node:dns/promises', () => ({ lookup: lookupMock }));
  vi.doMock('node:https', () => ({ default: { request: requestMock } }));
  const module = await import('../src/security/public-https-fetch.js');
  return { ...module, requestMock, lookupMock };
}

describe('fetchPublicHttpsBuffer', () => {
  test.each([
    ['http://example.com/a.png', /blocked_url/],
    ['https://user:pass@example.com/a.png', /blocked_url/],
    ['https://localhost/a.png', /ssrf_blocked_host/],
    ['https://printer.local/a.png', /ssrf_blocked_host/],
    ['https://[::ffff:169.254.169.254]/latest', /ssrf_blocked_host/],
    ['not a url', /invalid_url/],
  ])('rejects %s before any request', async (url, error) => {
    const { fetchPublicHttpsBuffer, requestMock } = await loadWithNetworkMocks([
      { address: '93.184.216.34', family: 4 },
    ]);

    await expect(fetchPublicHttpsBuffer(url)).rejects.toThrow(error);
    expect(requestMock).not.toHaveBeenCalled();
  });

  test('rejects public hostnames whose DNS answers are private', async () => {
    const { fetchPublicHttpsBuffer, requestMock } = await loadWithNetworkMocks([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);

    await expect(
      fetchPublicHttpsBuffer('https://rebind.example.com/a.png'),
    ).rejects.toThrow(/ssrf_blocked_host:rebind\.example\.com/);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
