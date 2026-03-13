import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('node:dns/promises');
  vi.doUnmock('node:https');
  vi.resetModules();
});

describe('discord CDN fetch helper', () => {
  test('blocks Discord CDN hosts that resolve to private addresses', async () => {
    const lookupMock = vi.fn(async () => [
      { address: '127.0.0.1', family: 4 as const },
    ]);
    const requestMock = vi.fn();

    vi.doMock('node:dns/promises', () => ({
      lookup: lookupMock,
    }));
    vi.doMock('node:https', () => ({
      default: {
        request: requestMock,
      },
    }));

    const { fetchDiscordCdnBuffer } = await import(
      '../src/channels/discord/discord-cdn-fetch.js'
    );

    await expect(
      fetchDiscordCdnBuffer(
        'https://cdn.discordapp.com/attachments/1/2/image.png',
      ),
    ).rejects.toThrow(/ssrf_blocked_host:cdn\.discordapp\.com/);
    expect(requestMock).not.toHaveBeenCalled();
  });

  test('returns bytes from allowed Discord CDN responses', async () => {
    const lookupMock = vi.fn(async () => [
      { address: '162.159.128.233', family: 4 as const },
    ]);
    const requestMock = vi.fn((url, _options, callback) => {
      let timeoutCallback: (() => void) | null = null;
      const requestListeners = new Map<
        string,
        Array<(error?: Error) => void>
      >();

      const request = {
        destroy(error?: Error) {
          if (error) {
            for (const listener of requestListeners.get('error') || []) {
              listener(error);
            }
          }
        },
        end() {
          const responseListeners = new Map<
            string,
            Array<(value?: Buffer | Error) => void>
          >();
          const response = {
            destroy(error?: Error) {
              if (error) {
                for (const listener of responseListeners.get('error') || []) {
                  listener(error);
                }
              }
            },
            headers: {
              'content-length': '7',
              'content-type': 'image/png',
            },
            on(event: string, listener: (value?: Buffer | Error) => void) {
              const current = responseListeners.get(event) || [];
              current.push(listener);
              responseListeners.set(event, current);
              return response;
            },
            resume() {
              return response;
            },
            statusCode: 200,
          };

          callback(response);
          for (const listener of responseListeners.get('data') || []) {
            listener(Buffer.from('pngdata'));
          }
          for (const listener of responseListeners.get('end') || []) {
            listener();
          }
        },
        on(event: string, listener: (error?: Error) => void) {
          const current = requestListeners.get(event) || [];
          current.push(listener);
          requestListeners.set(event, current);
          return request;
        },
        setTimeout(_timeoutMs: number, callbackFn: () => void) {
          timeoutCallback = callbackFn;
          return request;
        },
      };

      expect(timeoutCallback).toBeNull();
      expect(String(url)).toContain('cdn.discordapp.com');
      return request;
    });

    vi.doMock('node:dns/promises', () => ({
      lookup: lookupMock,
    }));
    vi.doMock('node:https', () => ({
      default: {
        request: requestMock,
      },
    }));

    const { fetchDiscordCdnBuffer } = await import(
      '../src/channels/discord/discord-cdn-fetch.js'
    );

    const result = await fetchDiscordCdnBuffer(
      'https://cdn.discordapp.com/attachments/1/2/image.png',
      { timeoutMs: 5000 },
    );

    expect(result.body.equals(Buffer.from('pngdata'))).toBe(true);
    expect(result.contentLength).toBe(7);
    expect(result.contentType).toBe('image/png');
    expect(lookupMock).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
