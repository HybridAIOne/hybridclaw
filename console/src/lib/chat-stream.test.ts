import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_EVENT } from '../api/client';
import { requestChatStream } from './chat-stream';

describe('requestChatStream', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches auth-required and surfaces the parsed error message on 401', async () => {
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
      requestChatStream('/api/chat', {
        token: 'test-token',
        body: { sessionId: 'session-a', stream: true },
        callbacks: {
          onTextDelta: vi.fn(),
          onApproval: vi.fn(),
        },
      }),
    ).rejects.toThrow('Unauthorized.');

    expect(fetch).toHaveBeenCalledWith(
      '/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/x-ndjson',
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ sessionId: 'session-a', stream: true }),
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({
      message: 'Unauthorized.',
    });

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  });

  it('warns when malformed NDJSON lines are ignored and still returns the final result', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onTextDelta = vi.fn();
    const onApproval = vi.fn();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      body: null,
      text: async () =>
        '{"type":"text","delta":"Hello"}\n{bad json\n{"type":"result","result":{"status":"ok","result":"Done"}}',
    } as Response);

    await expect(
      requestChatStream('/api/chat', {
        token: 'test-token',
        body: { sessionId: 'session-a', stream: true },
        callbacks: {
          onTextDelta,
          onApproval,
        },
      }),
    ).resolves.toMatchObject({
      status: 'ok',
      result: 'Done',
    });

    expect(onTextDelta).toHaveBeenCalledWith('Hello');
    expect(onApproval).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Ignoring malformed chat stream line',
      '{bad json',
    );

    warnSpy.mockRestore();
  });
});
