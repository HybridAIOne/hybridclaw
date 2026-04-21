import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callAnthropicProvider,
  callAnthropicProviderStream,
} from '../container/src/providers/anthropic.js';
import type { ChatMessage, ToolDefinition } from '../container/src/types.js';

function makeEventStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];
const tools: ToolDefinition[] = [];

const baseArgs = {
  provider: 'anthropic' as const,
  providerMethod: 'api-key',
  baseUrl: 'https://api.anthropic.com/v1',
  apiKey: 'test-key',
  model: 'anthropic/claude-sonnet-4-6',
  chatbotId: '',
  enableRag: false,
  requestHeaders: { 'anthropic-version': '2023-06-01' },
  messages,
  tools,
  maxTokens: 128,
  isLocal: false,
  contextWindow: 200_000,
  thinkingFormat: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Anthropic container provider', () => {
  test('sets an inference timeout signal on non-streaming API requests', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://api.anthropic.com/v1/messages');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('claude-sonnet-4-6');
        return new Response(
          JSON.stringify({
            id: 'msg_1',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 4,
              output_tokens: 2,
            },
            content: [{ type: 'text', text: 'hello back' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callAnthropicProvider({
      ...baseArgs,
      baseUrl: 'https://api.anthropic.com',
    });

    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.choices[0]?.message.content).toBe('hello back');
  });

  test('sets an inference timeout signal on streaming API requests', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return makeEventStreamResponse([
          'event: message_start\n',
          'data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-sonnet-4-6","usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
          'event: content_block_start\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"streamed"}}\n\n',
          'event: message_delta\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
        ]);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const deltas: string[] = [];
    const result = await callAnthropicProviderStream({
      ...baseArgs,
      onTextDelta: (delta) => deltas.push(delta),
      onActivity: () => undefined,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['streamed']);
    expect(result.choices[0]?.message.content).toBe('streamed');
  });
});
