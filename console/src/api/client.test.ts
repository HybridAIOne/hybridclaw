import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_REQUIRED_EVENT,
  buildWebCommandRequestBody,
  setRuntimeSecret,
  uploadSkillZip,
} from './client';

describe('client command helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds the shared web command payload with optional user identity', () => {
    expect(
      buildWebCommandRequestBody({
        sessionId: 'session-a',
        args: ['stop'],
      }),
    ).toEqual({
      sessionId: 'session-a',
      guildId: null,
      channelId: 'web',
      args: ['stop'],
    });

    expect(
      buildWebCommandRequestBody({
        sessionId: 'session-a',
        args: ['echo', 'hello'],
        userId: 'web-user-1',
        username: 'web',
      }),
    ).toEqual({
      sessionId: 'session-a',
      guildId: null,
      channelId: 'web',
      args: ['echo', 'hello'],
      userId: 'web-user-1',
      username: 'web',
    });
  });

  it('posts admin commands through the shared web command payload', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    await setRuntimeSecret('test-token', 'OPENAI_API_KEY', 'test-secret');

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
      sessionId: 'web-admin-secrets',
      guildId: null,
      channelId: 'web',
      args: ['secret', 'set', 'OPENAI_API_KEY', 'test-secret'],
    });
  });

  it('uploads skill zips through requestJson rawBody and custom content-type', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ skills: [] }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }),
    );

    const file = new File(['zip-bytes'], 'skill.zip', {
      type: 'application/zip',
    });

    await uploadSkillZip('test-token', file);

    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/skills/upload',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/zip',
        }),
        body: file,
      }),
    );
  });

  it('dispatches auth-required when skill zip upload returns 401', async () => {
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

    const file = new File(['zip-bytes'], 'skill.zip', {
      type: 'application/zip',
    });

    await expect(uploadSkillZip('test-token', file)).rejects.toThrow(
      'Unauthorized.',
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      message: 'Unauthorized.',
    });

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  });
});
