import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeProvider } from '../container/src/providers/provider-ids.js';
import { callProviderModelStream } from '../container/src/providers/router.js';
import {
  type NormalizedStreamCallArgs,
  ProviderRequestError,
} from '../container/src/providers/shared.js';

function streamArgs(
  provider: RuntimeProvider,
  isLocal: boolean,
): NormalizedStreamCallArgs {
  return {
    provider,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: `${provider}/test-model`,
    chatbotId: '',
    enableRag: false,
    requestHeaders: undefined,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 128,
    isLocal,
    contextWindow: 128_000,
    thinkingFormat: undefined,
    onTextDelta: () => undefined,
  };
}

/** Headers after `headersAfterMs` (never when null), body 60 s later; aborts like undici. */
function stubFetch(headersAfterMs: number | null) {
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason),
        );
        if (headersAfterMs === null) return;
        setTimeout(() => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener('abort', () =>
                controller.error(init.signal?.reason),
              );
              setTimeout(() => {
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              }, 60_000);
            },
          });
          resolve(
            new Response(body, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
          );
        }, headersAfterMs);
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('streaming response header timeout', () => {
  test.each<RuntimeProvider>([
    'hybridai',
    'anthropic',
    'openai',
    'openai-codex',
    'openrouter',
  ])('%s gives up when no headers arrive within 90 s', async (provider) => {
    vi.useFakeTimers();
    stubFetch(null);

    const result = callProviderModelStream(streamArgs(provider, false));
    const assertion = expect(result).rejects.toThrow(
      'Stream idle timeout after 90000ms waiting for response headers',
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  test('stops counting once the headers arrive', async () => {
    vi.useFakeTimers();
    stubFetch(80_000);

    const result = callProviderModelStream(streamArgs('hybridai', false));
    await vi.advanceTimersByTimeAsync(140_000);

    await expect(result).resolves.toMatchObject({
      choices: [{ message: { content: 'hi' } }],
    });
  });

  test.each<RuntimeProvider>(['ollama', 'lmstudio', 'llamacpp', 'vllm'])(
    'local %s keeps the transport timeout for model load and prefill',
    async (provider) => {
      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response('{"error":"boom"}', { status: 500 }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        callProviderModelStream(streamArgs(provider, true)),
      ).rejects.toBeInstanceOf(ProviderRequestError);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeUndefined();
    },
  );
});
