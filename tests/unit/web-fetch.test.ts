import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node:dns/promises');
  vi.unstubAllGlobals();
});

describe('web fetch timeout', () => {
  it('rejects and cancels a response body that stalls after headers', async () => {
    vi.useFakeTimers();
    const cancelMock = vi.fn();
    const stalledBody = new ReadableStream<Uint8Array>({
      cancel: cancelMock,
    });
    const fetchMock = vi.fn(async () => {
      return new Response(stalledBody, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');
    const outcome = webFetch({
      url: 'https://93.184.216.34/stalled-body',
      extractMode: 'text',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toMatchObject({
      name: 'TimeoutError',
      message: 'Web fetch timed out after 30000ms',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when the SSRF DNS lookup does not settle', async () => {
    vi.useFakeTimers();
    const lookupMock = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    vi.doMock('node:dns/promises', () => ({ lookup: lookupMock }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { webFetch } = await import('../../container/src/web-fetch.js');
    const outcome = webFetch({
      url: 'https://stalled.example/resource',
      extractMode: 'text',
    }).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(30_000);

    expect(await outcome).toMatchObject({
      name: 'TimeoutError',
      message: 'Web fetch timed out after 30000ms',
    });
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
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
    await expect(
      webFetch({ url: 'http://[::127.0.0.1]/admin', extractMode: 'text' }),
    ).rejects.toThrow(/SSRF guard/);
    await expect(
      webFetch({
        url: 'http://[64:ff9b::169.254.169.254]/latest/meta-data/',
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

describe('web fetch escalation and pagination', () => {
  const htmlResponse = (html: string) =>
    new Response(html, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  const article = `<article><h1>Exhibitors</h1>${'<p>Startup profile text for the exhibition list.</p>'.repeat(40)}</article>`;

  it.each([
    {
      name: 'a content page that loads a script from cdnjs.cloudflare.com',
      html: `<html><head><script src="https://cdnjs.cloudflare.com/x.js"></script></head><body>${article}</body></html>`,
      expected: undefined,
    },
    {
      name: 'a challenge page',
      html: '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>',
      expected: 'bot_blocked',
    },
    {
      name: 'an app shell loading reCAPTCHA',
      html: '<html><head><title>Example store</title><script src="https://www.google.com/recaptcha/enterprise.js"></script></head><body><div id="app"></div></body></html>',
      expected: 'spa_shell_only',
    },
    {
      name: 'a short page loading a Cloudflare library',
      html: '<html><head><script src="https://cdnjs.cloudflare.com/x.js"></script><style>.captcha { display: none }</style></head><body><h1>Example store</h1></body></html>',
      expected: undefined,
    },
    {
      name: 'a visible CAPTCHA challenge',
      html: '<html><body><h1>Verification required</h1><p>Complete the CAPTCHA to continue.</p></body></html>',
      expected: 'bot_blocked',
    },
  ])('flags bot blocking only for $name', async ({ html, expected }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => htmlResponse(html)),
    );
    const { webFetch } = await import('../../container/src/web-fetch.js');
    const result = await webFetch({ url: 'https://93.184.216.34/page' });
    expect(result.escalationHint).toBe(expected);
  });

  it.each([
    {
      name: 'Webflow pagination',
      link: '<a href="?9de5417e_page=2" aria-label="Next Page" class="w-pagination-next">Load more</a>',
      expected: 'https://93.184.216.34/exhibition?9de5417e_page=2',
    },
    {
      name: 'rel=next',
      link: '<link rel="next" href="/exhibition/page/2?a=1&amp;b=2">',
      expected: 'https://93.184.216.34/exhibition/page/2?a=1&b=2',
    },
    { name: 'no pagination', link: '', expected: undefined },
  ])('reports the next page for $name', async ({ link, expected }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse(
          `<html><head></head><body>${article}<div class="w-pagination-wrapper">${link}</div></body></html>`,
        ),
      ),
    );
    const { webFetch } = await import('../../container/src/web-fetch.js');
    const result = await webFetch({ url: 'https://93.184.216.34/exhibition' });
    expect(result.nextPageUrl).toBe(expected);
  });
});

describe('web fetch YouTube videos', () => {
  const htmlResponse = (html: string) =>
    new Response(html, { headers: { 'Content-Type': 'text/html' } });
  const watchHtml = readFileSync(
    new URL('../fixtures/youtube-watch.html', import.meta.url),
    'utf8',
  );
  const androidPlayer = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?lang=en&fmt=srv3',
            languageCode: 'en',
            name: { runs: [{ text: 'English' }] },
          },
          {
            baseUrl:
              'https://www.youtube.com/api/timedtext?lang=de&kind=asr&fmt=srv3',
            languageCode: 'de',
            kind: 'asr',
            name: { runs: [{ text: 'German (auto-generated)' }] },
          },
        ],
        audioTracks: [{ audioTrackId: 'de-DE.4' }],
        defaultAudioTrackIndex: 0,
      },
    },
  };

  function stubYouTube(routes: Record<string, () => Response>) {
    vi.doMock('node:dns/promises', () => ({
      lookup: async () => [{ address: '142.250.185.78', family: 4 }],
    }));
    const fetchMock = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      return routes[path]?.() ?? new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it.each([
    ['https://www.youtube.com/watch?v=wh24zJAg9lU&t=30s', 'wh24zJAg9lU'],
    ['https://m.youtube.com/watch?v=wh24zJAg9lU', 'wh24zJAg9lU'],
    ['https://youtu.be/aHASh13dcMA?si=x', 'aHASh13dcMA'],
    ['https://www.youtube.com/shorts/KCfRRypk-dE', 'KCfRRypk-dE'],
    ['https://youtube.com/live/KCfRRypk-dE', 'KCfRRypk-dE'],
    ['https://www.youtube.com/@niciathome', undefined],
    ['https://www.youtube.com.example.com/watch?v=wh24zJAg9lU', undefined],
  ])('recognises %s', async (url, expected) => {
    const { youtubeVideoId } = await import(
      '../../container/src/web-fetch-youtube.js'
    );
    expect(youtubeVideoId(url)).toBe(expected);
  });

  it('returns the description and transcript from the player JSON', async () => {
    const fetchMock = stubYouTube({
      '/watch': () => htmlResponse(watchHtml),
      '/youtubei/v1/player': () => Response.json(androidPlayer),
      '/api/timedtext': () =>
        new Response(
          '<transcript><text start="1">Hallo und willkommen</text><text start="2">it&amp;#39;s Herbst</text></transcript>',
        ),
    });
    const { webFetch } = await import('../../container/src/web-fetch.js');
    const result = await webFetch({ url: 'https://youtu.be/wh24zJAg9lU' });

    expect(result).toMatchObject({
      extractor: 'youtube',
      title: '9 HERBSTDEKO IDEEN, die jeder nachmachen kann!',
      escalationHint: undefined,
    });
    expect(result.text).toContain(
      'Channel: NICI AT HOME (https://www.youtube.com/@niciathome)\nPublished: 2026-09-13\nDuration: 24:48\nViews: 47,385',
    );
    expect(result.text).toContain('⭐ Blumenübertopf Edzard');
    expect(result.text).toContain('XOXO </script> \\ Nici');
    expect(result.text).toContain(
      '## Transcript: German (auto-generated)\n\nHallo und willkommen it\'s Herbst',
    );
    expect(result.text).not.toContain('About');
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain(
      'https://www.youtube.com/api/timedtext?lang=de&kind=asr',
    );
    const watchCall = fetchMock.mock.calls.find(([url]) =>
      url.includes('/watch'),
    );
    expect(watchCall?.[1]).toMatchObject({
      headers: expect.objectContaining({ Cookie: 'SOCS=CAI' }),
    });
  });

  it('falls back to oEmbed when YouTube walls the page', async () => {
    stubYouTube({
      '/watch': () =>
        htmlResponse(
          `<html><head><title> - YouTube</title></head><body><script>var ytInitialPlayerResponse = ${JSON.stringify(
            {
              playabilityStatus: {
                status: 'LOGIN_REQUIRED',
                reason: 'Sign in to confirm you’re not a bot',
              },
            },
          )};</script></body></html>`,
        ),
      '/youtubei/v1/player': () => new Response('', { status: 403 }),
      '/oembed': () =>
        Response.json({
          title: '9 HERBSTDEKO IDEEN',
          author_name: 'NICI AT HOME',
          author_url: 'https://www.youtube.com/@niciathome',
        }),
    });
    const { webFetch } = await import('../../container/src/web-fetch.js');
    const result = await webFetch({
      url: 'https://www.youtube.com/watch?v=wh24zJAg9lU',
    });

    expect(result).toMatchObject({
      extractor: 'youtube-oembed',
      title: '9 HERBSTDEKO IDEEN',
      escalationHint: undefined,
    });
    expect(result.text).toContain(
      'Channel: NICI AT HOME (https://www.youtube.com/@niciathome)',
    );
    expect(result.text).toContain(
      'could not be read (YouTube: "Sign in to confirm you’re not a bot")',
    );
  });
});
