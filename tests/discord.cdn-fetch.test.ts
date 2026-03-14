import { afterEach, describe, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  test('rejects stalled responses when the read idle timeout expires', async () => {
    vi.useFakeTimers();

    const lookupMock = vi.fn(async () => [
      { address: '162.159.128.233', family: 4 as const },
    ]);
    const requestMock = vi.fn((url, _options, callback) => {
      const requestListeners = new Map<
        string,
        Array<(error?: Error) => void>
      >();
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

      const request = {
        destroy(error?: Error) {
          if (error) {
            for (const listener of requestListeners.get('error') || []) {
              listener(error);
            }
          }
        },
        end() {
          callback(response);
        },
        on(event: string, listener: (error?: Error) => void) {
          const current = requestListeners.get(event) || [];
          current.push(listener);
          requestListeners.set(event, current);
          return request;
        },
        setTimeout(_timeoutMs: number, _callbackFn: () => void) {
          return request;
        },
      };

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

    const promise = fetchDiscordCdnBuffer(
      'https://cdn.discordapp.com/attachments/1/2/image.png',
      {
        readIdleTimeoutMs: 100,
        timeoutMs: 5_000,
      },
    );
    const assertion = expect(promise).rejects.toThrow(/read_idle_timeout/);

    await vi.advanceTimersByTimeAsync(101);

    await assertion;
  });

  test('resets the read idle timeout after each response chunk', async () => {
    vi.useFakeTimers();

    const lookupMock = vi.fn(async () => [
      { address: '162.159.128.233', family: 4 as const },
    ]);
    let emitResponseEvent:
      | ((event: 'data' | 'end', value?: Buffer) => void)
      | null = null;

    const requestMock = vi.fn((url, _options, callback) => {
      const requestListeners = new Map<
        string,
        Array<(error?: Error) => void>
      >();
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
          'content-length': '6',
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

      emitResponseEvent = (event, value) => {
        for (const listener of responseListeners.get(event) || []) {
          listener(value);
        }
      };

      const request = {
        destroy(error?: Error) {
          if (error) {
            for (const listener of requestListeners.get('error') || []) {
              listener(error);
            }
          }
        },
        end() {
          callback(response);
        },
        on(event: string, listener: (error?: Error) => void) {
          const current = requestListeners.get(event) || [];
          current.push(listener);
          requestListeners.set(event, current);
          return request;
        },
        setTimeout(_timeoutMs: number, _callbackFn: () => void) {
          return request;
        },
      };

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

    const promise = fetchDiscordCdnBuffer(
      'https://cdn.discordapp.com/attachments/1/2/image.png',
      {
        readIdleTimeoutMs: 100,
        timeoutMs: 5_000,
      },
    );

    await vi.advanceTimersByTimeAsync(80);
    emitResponseEvent?.('data', Buffer.from('abc'));
    await vi.advanceTimersByTimeAsync(80);
    emitResponseEvent?.('data', Buffer.from('def'));
    emitResponseEvent?.('end');

    const result = await promise;

    expect(result.body.equals(Buffer.from('abcdef'))).toBe(true);
    expect(result.contentLength).toBe(6);
    expect(result.contentType).toBe('image/png');
  });

  test('rejects when the response closes before end', async () => {
    const lookupMock = vi.fn(async () => [
      { address: '162.159.128.233', family: 4 as const },
    ]);
    let emitResponseEvent: ((event: 'close') => void) | null = null;

    const requestMock = vi.fn((url, _options, callback) => {
      const requestListeners = new Map<
        string,
        Array<(error?: Error) => void>
      >();
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

      emitResponseEvent = (event) => {
        for (const listener of responseListeners.get(event) || []) {
          listener();
        }
      };

      const request = {
        destroy(error?: Error) {
          if (error) {
            for (const listener of requestListeners.get('error') || []) {
              listener(error);
            }
          }
        },
        end() {
          callback(response);
        },
        on(event: string, listener: (error?: Error) => void) {
          const current = requestListeners.get(event) || [];
          current.push(listener);
          requestListeners.set(event, current);
          return request;
        },
        setTimeout(_timeoutMs: number, _callbackFn: () => void) {
          return request;
        },
      };

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

    const promise = fetchDiscordCdnBuffer(
      'https://cdn.discordapp.com/attachments/1/2/image.png',
      {
        readIdleTimeoutMs: 5_000,
        timeoutMs: 5_000,
      },
    );
    await vi.waitFor(() => {
      expect(emitResponseEvent).not.toBeNull();
    });
    emitResponseEvent?.('close');

    const outcome = await Promise.race([
      promise.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<string>((resolve) => {
        setTimeout(() => resolve('pending'), 25);
      }),
    ]);

    expect(outcome).toBe('response_closed_prematurely');
  });
});
