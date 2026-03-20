import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
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
    const result = await webFetch({
      url: 'https://example.com/cloudflare-challenge-retry',
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
    const result = await webFetch({
      url: 'https://example.com/plain-403-no-retry',
      extractMode: 'text',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(403);
    expect(result.escalationHint).toBe('bot_blocked');
  });
});
