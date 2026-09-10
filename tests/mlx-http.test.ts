import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fetchMlxWithIdleTimeout, MLX_IDLE_TIMEOUT_MS } from '../container/shared/mlx-http.js';
import { fetchMlx } from '../container/src/providers/mlx-transport.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function nativeStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let signal!: AbortSignal;
  const cancel = vi.fn();
  const request = vi.fn(async (_url, init) => {
    signal = init.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
      cancel,
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  vi.stubGlobal('fetch', request);
  return { request, cancel, signal: () => signal, send: () => controller.enqueue(new TextEncoder().encode('data: reasoning\n\n')), end: () => controller.close() };
}

test('direct local generation remains alive beyond three minutes while receiving progress', async () => {
  const native = nativeStream();
  const response = await fetchMlx('http://127.0.0.1:8321/v1/chat/completions', { method: 'POST', body: '{}' }, 'task_a');
  expect(native.request.mock.calls[0][1].redirect).toBe('error');
  expect(native.request.mock.calls[0][1].headers.get('X-HybridClaw-Task')).toBe('task_a');
  const reader = response.body!.getReader();
  for (let step = 0; step < 10; step++) {
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(native.signal().aborted).toBe(false);
    native.send();
    expect((await pending).done).toBe(false);
  }
  native.end();
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a native connection that stops sending progress is cancelled', async () => {
  const native = nativeStream();
  const response = await fetchMlxWithIdleTimeout('http://127.0.0.1:8321/v1/chat/completions', {});
  const reader = response.body!.getReader();
  const result = expect(reader.read()).rejects.toThrow('stopped making progress');
  await vi.advanceTimersByTimeAsync(MLX_IDLE_TIMEOUT_MS);
  await result;
  expect(native.signal().aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stalled request before headers is cancelled', async () => {
  vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  })));
  const result = expect(fetchMlxWithIdleTimeout('http://127.0.0.1:8321/v1/chat/completions', {})).rejects.toThrow('stopped making progress');
  await vi.advanceTimersByTimeAsync(MLX_IDLE_TIMEOUT_MS);
  await result;
  expect(vi.getTimerCount()).toBe(0);
});

test('user cancellation propagates through an active native request', async () => {
  const native = nativeStream();
  const abort = new AbortController();
  const response = await fetchMlxWithIdleTimeout('http://127.0.0.1:8321/v1/chat/completions', { signal: abort.signal });
  const result = expect(response.body!.getReader().read()).rejects.toThrow('user stopped');
  abort.abort(new Error('user stopped'));
  await result;
  expect(native.signal().aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('cancelling a response body releases its native request and timer', async () => {
  const native = nativeStream();
  const response = await fetchMlxWithIdleTimeout('http://127.0.0.1:8321/v1/chat/completions', {});
  await response.body!.cancel();
  expect(native.signal().aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('HTTP errors preserve status and body and release the idle timer', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"example error"}', { status: 400 })));
  const response = await fetchMlxWithIdleTimeout('http://127.0.0.1:8321/v1/chat/completions', {});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'example error' });
  expect(vi.getTimerCount()).toBe(0);
});
