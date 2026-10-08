import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactUrl, executeCommand } from './chat';

describe('chat artifact helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds artifact URLs without embedding the auth token', () => {
    expect(artifactUrl('/tmp/report.pdf')).toBe(
      '/api/artifact?path=%2Ftmp%2Freport.pdf',
    );
    expect(artifactUrl('/tmp/report.pdf')).not.toContain('token=');
  });

  it('posts chat commands through the shared web command payload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await executeCommand('test-token', 'session-a', 'web-user-1', ['stop']);

    expect(fetch).toHaveBeenCalledWith(
      '/api/command',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(JSON.parse(String(request?.body))).toEqual({
      sessionId: 'session-a',
      guildId: null,
      channelId: 'web',
      args: ['stop'],
      userId: 'web-user-1',
      username: 'web',
    });
  });
});
