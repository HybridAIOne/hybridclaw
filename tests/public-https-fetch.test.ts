import { EventEmitter } from 'node:events';
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

  test.each([201, 302, 410])('guarded POST writes its encrypted body and handles HTTP %s without redirects', async (statusCode) => {
    const { fetchPublicHttpsBuffer, requestMock } = await loadWithNetworkMocks([
      { address: '93.184.216.34', family: 4 },
    ]);
    const body = Buffer.from('encrypted payload');
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(),
    });
    requestMock.mockImplementation((_url, _options, callback) => {
      request.end.mockImplementation(() => {
        const response = Object.assign(new EventEmitter(), { statusCode, headers: { location: 'https://localhost/' }, resume: vi.fn() });
        callback(response);
        response.emit('end');
      });
      return request;
    });
    const result = fetchPublicHttpsBuffer('https://push.example.com/send', { method: 'POST', body, headers: { Authorization: 'test-key' }, maxBytes: 4096 });
    if (statusCode === 201) await expect(result).resolves.toMatchObject({ body: Buffer.alloc(0) });
    else await expect(result).rejects.toThrow(`http_${statusCode}`);
    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock.mock.calls[0][1]).toMatchObject({ method: 'POST', headers: { Authorization: 'test-key' }, lookup: expect.any(Function) });
    expect(request.end).toHaveBeenCalledWith(body);
  });

  test('fetch-shaped variant returns a redirect as its status instead of following it', async () => {
    const { fetchPublicHttps, requestMock } = await loadWithNetworkMocks([
      { address: '93.184.216.34', family: 4 },
    ]);
    const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn() });
    requestMock.mockImplementation((_url, _options, callback) => {
      request.end.mockImplementation(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 302, headers: { location: 'https://169.254.169.254/' } });
        callback(response);
        response.emit('end');
      });
      return request;
    });

    const response = await fetchPublicHttps('https://peer.example.com/a2a', { method: 'POST', body: '{}' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://169.254.169.254/');
    expect(requestMock).toHaveBeenCalledOnce();
  });

  test('guarded POST rejects DNS rebinding at connection time', async () => {
    const { fetchPublicHttpsBuffer, requestMock, lookupMock } = await loadWithNetworkMocks([
      { address: '93.184.216.34', family: 4 },
    ]);
    lookupMock.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), end: vi.fn() });
    requestMock.mockImplementation((_url, options) => {
      request.end.mockImplementation(() => options.lookup('push.example.com', {}, (error: Error) => request.emit('error', error)));
      return request;
    });
    await expect(fetchPublicHttpsBuffer('https://push.example.com/send', { method: 'POST', body: Buffer.from('encrypted') })).rejects.toThrow(/ssrf_blocked_host/);
  });
});
