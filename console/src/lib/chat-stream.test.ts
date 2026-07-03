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

  it('dispatches thinking deltas and tool progress events to their callbacks', async () => {
    const onTextDelta = vi.fn();
    const onApproval = vi.fn();
    const onThinkingDelta = vi.fn();
    const onToolEvent = vi.fn();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      body: null,
      text: async () =>
        [
          '{"type":"thinking","delta":"Hmm"}',
          '{"type":"tool","toolName":"exec","phase":"start","preview":"ls"}',
          '{"type":"tool","toolName":"exec","phase":"finish","preview":"ok","durationMs":12}',
          '{"type":"tool","phase":"start"}',
          '{"type":"result","result":{"status":"ok","result":"Done"}}',
        ].join('\n'),
    } as Response);

    await expect(
      requestChatStream('/api/chat', {
        token: 'test-token',
        body: { sessionId: 'session-a', stream: true },
        callbacks: {
          onTextDelta,
          onApproval,
          onThinkingDelta,
          onToolEvent,
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', result: 'Done' });

    expect(onThinkingDelta).toHaveBeenCalledWith('Hmm');
    expect(onToolEvent).toHaveBeenNthCalledWith(1, {
      type: 'tool',
      toolName: 'exec',
      phase: 'start',
      preview: 'ls',
    });
    expect(onToolEvent).toHaveBeenNthCalledWith(2, {
      type: 'tool',
      toolName: 'exec',
      phase: 'finish',
      preview: 'ok',
      durationMs: 12,
    });
    // The toolName-less line is malformed and must not reach the callback.
    expect(onToolEvent).toHaveBeenCalledTimes(2);
    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('ignores thinking and tool lines when their callbacks are not provided', async () => {
    const onTextDelta = vi.fn();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      body: null,
      text: async () =>
        [
          '{"type":"thinking","delta":"Hmm"}',
          '{"type":"tool","toolName":"exec","phase":"start"}',
          '{"type":"text","delta":"Hi"}',
          '{"type":"result","result":{"status":"ok","result":"Hi"}}',
        ].join('\n'),
    } as Response);

    await expect(
      requestChatStream('/api/chat', {
        token: 'test-token',
        body: { sessionId: 'session-a', stream: true },
        callbacks: {
          onTextDelta,
          onApproval: vi.fn(),
        },
      }),
    ).resolves.toMatchObject({ status: 'ok', result: 'Hi' });

    expect(onTextDelta).toHaveBeenCalledWith('Hi');
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
