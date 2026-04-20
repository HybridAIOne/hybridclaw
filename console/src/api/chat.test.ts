import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactUrl, executeCommand, fetchArtifactBlob } from './chat';
import { AUTH_REQUIRED_EVENT } from './client';

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

  it('fetches artifacts with Authorization headers and dispatches auth-required on 401', async () => {
    const events: CustomEvent[] = [];
    const listener = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized.' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await expect(
      fetchArtifactBlob('test-token', '/tmp/report.pdf'),
    ).rejects.toThrow('Unauthorized.');

    expect(fetch).toHaveBeenCalledWith(
      '/api/artifact?path=%2Ftmp%2Freport.pdf',
      expect.objectContaining({
        cache: 'no-store',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      message: 'Unauthorized.',
    });

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
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
