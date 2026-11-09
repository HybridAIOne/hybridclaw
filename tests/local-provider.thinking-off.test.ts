import { expect, test, vi } from 'vitest';
import {
  callLocalOpenAICompatProvider,
  callLocalOpenAICompatProviderStream,
} from '../container/src/providers/local-openai-compat.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true });

test.each([false, true])(
  'vLLM Qwen thinking control, stream=%s',
  async (stream) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      stream
        ? new Response(
            'data: {"choices":[{"delta":{"content":"READY"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          )
        : new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: 'assistant', content: 'READY' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const call = stream
      ? callLocalOpenAICompatProviderStream
      : callLocalOpenAICompatProvider;
    for (const effort of [undefined, 'none'] as const) {
      await call({
        provider: 'vllm',
        baseUrl: 'http://127.0.0.1:8000/v1',
        apiKey: '',
        model: 'vllm/Qwen/test-model',
        chatbotId: '',
        enableRag: false,
        messages: [{ role: 'user', content: 'Return READY' }],
        tools: [],
        reasoningEffort: effort,
        modelBehavior: { thinkingFormat: 'qwen' },
        requestHeaders: undefined,
        maxTokens: 128,
        isLocal: true,
        contextWindow: 8192,
        thinkingFormat: 'qwen',
        onTextDelta: () => {},
      });
      const body = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body));
      expect(body.chat_template_kwargs).toEqual(
        effort === 'none' ? { enable_thinking: false } : undefined,
      );
    }
  },
);
