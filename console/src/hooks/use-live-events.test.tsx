import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUIRED_EVENT } from '../api/client';
import type { AdminOverview, GatewayStatus } from '../api/types';
import { useLiveEvents } from './use-live-events';

const encoder = new TextEncoder();

interface ControlledStream {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
  error: (reason: unknown) => void;
  canceled: () => boolean;
}

function createSseStream(): ControlledStream {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;
  let wasCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      wasCanceled = true;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
    }),
    push(chunk: string) {
      streamController?.enqueue(encoder.encode(chunk));
    },
    close() {
      streamController?.close();
    },
    error(reason: unknown) {
      streamController?.error(reason);
    },
    canceled: () => wasCanceled,
  };
}

function makeStatus(overrides?: Partial<GatewayStatus>): GatewayStatus {
  return {
    status: 'ok',
    version: '0.44.1',
    uptime: 120,
    sessions: 3,
    activeContainers: 1,
    defaultModel: 'test-model',
    ...overrides,
  } as GatewayStatus;
}

function makeOverview(status: GatewayStatus): AdminOverview {
  return {
    status,
    recentSessions: [],
  } as unknown as AdminOverview;
}

describe('useLiveEvents', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends the bearer token in the Authorization header and never in the URL', async () => {
    const stream = createSseStream();
    const fetchMock = vi.mocked(fetch).mockResolvedValue(stream.response);

    const { result, unmount } = renderHook(() =>
      useLiveEvents('  test-token  '),
    );

    expect(result.current.connection).toBe('connecting');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/events');
    expect(String(url)).not.toContain('test-token');
    expect(init).toMatchObject({
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Authorization: 'Bearer test-token',
        Accept: 'text/event-stream',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      stream.push(`event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`);
    });
    await waitFor(() => expect(result.current.connection).toBe('open'));

    unmount();
  });

  it('omits the Authorization header and sends same-origin cookies when token is empty', async () => {
    const stream = createSseStream();
    const fetchMock = vi.mocked(fetch).mockResolvedValue(stream.response);

    const { result, unmount } = renderHook(() => useLiveEvents(''));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/events');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).toEqual({
      Accept: 'text/event-stream',
    });

    await act(async () => {
      stream.push(`event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`);
    });
    await waitFor(() => expect(result.current.connection).toBe('open'));

    unmount();
  });

  it('parses overview, status, multi-line data, comments, and retry fields', async () => {
    const stream = createSseStream();
    vi.mocked(fetch).mockResolvedValue(stream.response);

    const { result, unmount } = renderHook(() => useLiveEvents('test-token'));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    const status = makeStatus({ sessions: 7 });
    const overview = makeOverview(status);
    const prettyOverviewLines = JSON.stringify(overview, null, 2)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\n');

    await act(async () => {
      stream.push(': keepalive\n\n');
      stream.push('retry: 5000\nid: 1\n\n');
      stream.push(`event: overview\n${prettyOverviewLines}\n\n`);
    });

    await waitFor(() => expect(result.current.overview).toEqual(overview));
    expect(result.current.connection).toBe('open');
    expect(result.current.lastEventAt).not.toBeNull();

    const updatedStatus = makeStatus({ sessions: 9, activeContainers: 2 });
    await act(async () => {
      stream.push('event: unknown\ndata: {"ignored":true}\n\n');
      stream.push('event: status\ndata: not-json\n\n');
      stream.push(`event: status\ndata: ${JSON.stringify(updatedStatus)}\n\n`);
    });

    await waitFor(() => expect(result.current.status).toEqual(updatedStatus));
    expect(result.current.connection).toBe('open');

    unmount();
  });

  it('stops retrying and dispatches auth-required on 401', async () => {
    vi.useFakeTimers();
    const authEvents: CustomEvent[] = [];
    const listener = (event: Event) => {
      authEvents.push(event as CustomEvent);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, listener);

    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result, unmount } = renderHook(() => useLiveEvents('test-token'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.connection).toBe('error');
    expect(authEvents).toHaveLength(1);
    expect(authEvents[0]?.detail).toMatchObject({ message: 'Unauthorized.' });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
    unmount();
  });

  it('stops retrying without dispatching auth-required on 403', async () => {
    vi.useFakeTimers();
    const authListener = vi.fn();
    window.addEventListener(AUTH_REQUIRED_EVENT, authListener);

    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden.' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result, unmount } = renderHook(() => useLiveEvents('test-token'));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.connection).toBe('error');
    expect(authListener).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_REQUIRED_EVENT, authListener);
    unmount();
  });

  it('backs off without opening when a 200 response has a non-SSE content-type', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch).mockImplementation(
      async () =>
        new Response('<html><body>fallback</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    );

    const seenConnections: string[] = [];
    const { result, unmount } = renderHook(() => {
      const state = useLiveEvents('test-token');
      seenConnections.push(state.connection);
      return state;
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe('error');
    expect(seenConnections).not.toContain('open');

    // First retry after 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe('error');

    // Second retry backs off to 2000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(seenConnections).not.toContain('open');

    unmount();
  });

  it('backs off without opening when a 200 text/event-stream closes before any frame', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch).mockImplementation(async () => {
      const stream = createSseStream();
      stream.close();
      return stream.response;
    });

    const seenConnections: string[] = [];
    const { result, unmount } = renderHook(() => {
      const state = useLiveEvents('test-token');
      seenConnections.push(state.connection);
      return state;
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.connection).toBe('error');
    expect(seenConnections).not.toContain('open');

    // First retry fires at 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe('error');

    // Because no frame was parsed, backoff grows to 2000ms instead of resetting to 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(seenConnections).not.toContain('open');

    unmount();
  });

  it('reconnects with exponential backoff on network errors and stream disconnects', async () => {
    vi.useFakeTimers();
    const firstStream = createSseStream();
    const secondStream = createSseStream();
    const thirdStream = createSseStream();
    const fetchMock = vi
      .mocked(fetch)
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(secondStream.response)
      .mockResolvedValueOnce(thirdStream.response);

    const { result, unmount } = renderHook(() => useLiveEvents('test-token'));

    // First attempt rejects -> error, retry scheduled in 1000ms.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.connection).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second attempt returns 502 -> stays error, retry scheduled in 2000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.connection).toBe('error');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third attempt parses a frame -> opens and resets backoff to 1000ms.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      firstStream.push(
        `event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.connection).toBe('open');

    // Clean stream EOF triggers reconnect after reset 1000ms delay.
    await act(async () => {
      firstStream.close();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.connection).toBe('error');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      secondStream.push(
        `event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.connection).toBe('open');

    // Mid-stream read error also transitions to error and schedules reconnect.
    await act(async () => {
      secondStream.error(new Error('socket reset'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.connection).toBe('error');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      thirdStream.push(
        `event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.connection).toBe('open');

    unmount();
  });

  it('aborts the active stream on unmount and reopens when the token changes', async () => {
    const firstStream = createSseStream();
    const secondStream = createSseStream();
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(secondStream.response);

    const { result, rerender, unmount } = renderHook(
      ({ token }) => useLiveEvents(token),
      { initialProps: { token: 'token-a' } },
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      firstStream.push(
        `event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`,
      );
    });
    await waitFor(() => expect(result.current.connection).toBe('open'));

    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    rerender({ token: 'token-b' });

    expect(firstSignal.aborted).toBe(true);
    expect(firstStream.canceled()).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      secondStream.push(
        `event: status\ndata: ${JSON.stringify(makeStatus())}\n\n`,
      );
    });
    await waitFor(() => expect(result.current.connection).toBe('open'));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer token-b',
    });

    const secondSignal = fetchMock.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(secondSignal.aborted).toBe(false);

    unmount();

    expect(secondSignal.aborted).toBe(true);
    expect(secondStream.canceled()).toBe(true);
  });
});
