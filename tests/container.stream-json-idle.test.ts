import { afterEach, expect, test, vi } from 'vitest';
import type { RuntimeProviderId } from '../container/src/providers/provider-ids.js';
import { callProviderModelStream } from '../container/src/providers/router.js';
import type { NormalizedStreamCallArgs } from '../container/src/providers/shared.js';
import { STREAM_IDLE_TIMEOUT_MS } from '../container/src/providers/stream-utils.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true });
afterEach(() => vi.useRealTimers());

function args(provider: RuntimeProviderId): NormalizedStreamCallArgs {
  return {
    provider,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'test-key',
    model: `${provider}/test-model`,
    chatbotId: '',
    enableRag: false,
    requestHeaders: undefined,
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 128,
    isLocal: false,
    contextWindow: 128_000,
    thinkingFormat: undefined,
    onTextDelta: () => undefined,
  };
}

test.each<RuntimeProviderId>([
  'hybridai',
  'openrouter',
  'openai',
  'openai-codex',
])(
  '%s retains the idle deadline when a streaming endpoint responds with JSON',
  async (provider) => {
    vi.useFakeTimers();
    let control: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        control = controller;
      },
      cancel,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    let completed = false;
    let errorMessage: string | undefined;
    const result = callProviderModelStream(args(provider)).then(
      () => {
        completed = true;
      },
      (error: unknown) => {
        completed = true;
        errorMessage = String(error);
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
      expect(completed).toBe(true);
      expect(errorMessage).toContain('idle timeout');
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      try {
        control?.error(new Error('Synthetic stream cleanup'));
      } catch {}
      await result;
    }
  },
);

test('JSON chunks reset the idle deadline and preserve split UTF-8, tools and usage', async () => {
  vi.useFakeTimers();
  const payload = {
    id: 'completion-test',
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'Ready 🐈',
          tool_calls: [
            {
              id: 'read-notes',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"notes.txt"}' },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const split = bytes.indexOf(0xf0) + 2;
  let control: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
    },
    cancel,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  const result = callProviderModelStream(args('openrouter'));
  const assertion = expect(result).resolves.toMatchObject({
    choices: payload.choices,
    usage: payload.usage,
  });
  try {
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 10_000);
    control?.enqueue(bytes.slice(0, split));
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 10_000);
    control?.enqueue(bytes.slice(split));
    control?.close();
    await assertion;
    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    try {
      control?.error(new Error('Synthetic stream cleanup'));
    } catch {}
    await result.catch(() => undefined);
  }
});

test('JSON fallback still surfaces malformed responses', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{broken', {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  await expect(
    callProviderModelStream(args('openrouter')),
  ).rejects.toBeInstanceOf(SyntaxError);
});
