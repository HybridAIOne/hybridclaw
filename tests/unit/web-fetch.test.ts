import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:dns/promises');
  vi.unstubAllGlobals();
});

describe('web fetch Cloudflare challenge retry', () => {
  it('retries once with an honest bot user agent after a Cloudflare challenge', async () => {
    const challengeResponse = new Response('challenge', {
      status: 403,
      statusText: 'Forbidden',
      headers: {
        'Cf-Mitigated': 'challenge',
        'Content-Type': 'text/plain',
      },
    });
    const challengeBody = challengeResponse.body;
    if (!challengeBody) {
      throw new Error('Expected challenge response body to exist');
    }
    const cancelSpy = vi.spyOn(challengeBody, 'cancel');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(challengeResponse)
      .mockResolvedValueOnce(
        new Response('Allowed content via bot allowlist.', {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { BOT_USER_AGENT, webFetch } = await import(
      '../../container/src/web-fetch.js'
    );
    // Use a public literal IP so these behavior tests avoid exercising the
    // SSRF guard's DNS lookup path.
    const result = await webFetch({
      url: 'https://93.184.216.34/cloudflare-challenge-retry',
      extractMode: 'text',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'User-Agent': expect.stringContaining('Chrome/122.0.0.0'),
      }),
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'User-Agent': BOT_USER_AGENT,
      }),
    });
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(result.text).toBe('Allowed content via bot allowlist.');
  });

  it('does not retry a 403 response without the Cloudflare challenge header', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('Access denied', {
        status: 403,
        statusText: 'Forbidden',
        headers: {
          'Content-Type': 'text/plain',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');
    // Use a public literal IP so these behavior tests avoid exercising the
    // SSRF guard's DNS lookup path.
    const result = await webFetch({
      url: 'https://93.184.216.34/plain-403-no-retry',
      extractMode: 'text',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(403);
    expect(result.escalationHint).toBe('bot_blocked');
  });
});

describe('web fetch SSRF guard', () => {
  it('blocks literal metadata and loopback hosts before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');

    await expect(
      webFetch({
        url: 'http://169.254.169.254/latest/meta-data/',
        extractMode: 'text',
      }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({ url: 'http://127.0.0.1:8080/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({ url: 'http://[::1]/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({ url: 'http://[::]/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({ url: 'http://[fc00::1]/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({ url: 'http://[fe80::1]/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({
        url: 'http://[::ffff:a9fe:fea9]/latest/meta-data/',
        extractMode: 'text',
      }),
    ).rejects.toThrow(/SSRF guard/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks hostnames when DNS lookup fails', async () => {
    const lookupMock = vi.fn(async () => {
      throw new Error('dns unavailable');
    });
    vi.doMock('node:dns/promises', () => ({ lookup: lookupMock }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');

    await expect(
      webFetch({
        url: 'https://unresolvable.example/resource',
        extractMode: 'text',
      }),
    ).rejects.toThrow(/DNS lookup failed/);
    expect(lookupMock).toHaveBeenCalledWith('unresolvable.example', {
      all: true,
      verbatim: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const lookupMock = vi.fn(async () => [{ address: '10.0.0.12', family: 4 }]);
    vi.doMock('node:dns/promises', () => ({ lookup: lookupMock }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');

    await expect(
      webFetch({
        url: 'https://metadata.internal.example/latest/meta-data/',
        extractMode: 'text',
      }),
    ).rejects.toThrow(/SSRF guard/);
    expect(lookupMock).toHaveBeenCalledWith('metadata.internal.example', {
      all: true,
      verbatim: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks redirects to private hosts', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('', {
        status: 302,
        headers: {
          Location: 'http://169.254.169.254/latest/meta-data/',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');

    await expect(
      webFetch({
        url: 'https://93.184.216.34/redirect-to-metadata',
        extractMode: 'text',
      }),
    ).rejects.toThrow(/SSRF guard/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
