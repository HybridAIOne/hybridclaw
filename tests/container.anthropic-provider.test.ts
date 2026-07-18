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
        expect(body.thinking).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
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

  test('marks the system prompt as an Anthropic cache breakpoint', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.system).toEqual([
          {
            type: 'text',
            text: 'Static system prompt',
            cache_control: { type: 'ephemeral' },
          },
        ]);
        expect(body.messages).toEqual([
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hello',
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'text',
                text: '<context>\nDate (UTC): 2026-05-13\n</context>',
              },
            ],
          },
        ]);
        return new Response(
          JSON.stringify({
            id: 'msg_cache',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              cache_creation_input_tokens: 1200,
            },
            content: [{ type: 'text', text: 'cached' }],
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
      messages: [
        { role: 'system', content: 'Static system prompt' },
        {
          role: 'user',
          content: '<context>\nDate (UTC): 2026-05-13\n</context>',
        },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.usage?.cache_creation_input_tokens).toBe(1200);
  });

  test('uses three volatility-ordered system breakpoints and caches the stable user block before dynamic context', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.system).toEqual([
          {
            type: 'text',
            text: 'Static core',
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: 'Workspace memory',
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: 'Skills catalog',
            cache_control: { type: 'ephemeral' },
          },
        ]);
        expect(body.messages).toEqual([
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'hello',
                cache_control: { type: 'ephemeral' },
              },
              {
                type: 'text',
                text: '<context>\nDate (UTC): 2026-05-13\n</context>',
              },
            ],
          },
        ]);
        return new Response(
          JSON.stringify({
            id: 'msg_blocks',
            model: 'claude-sonnet-4-6',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'cached' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await callAnthropicProvider({
      ...baseArgs,
      messages: [
        { role: 'system', content: 'Static core' },
        { role: 'system', content: 'Workspace memory' },
        { role: 'system', content: 'Skills catalog' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            {
              type: 'text',
              text: '<context>\nDate (UTC): 2026-05-13\n</context>',
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('does not impose a total-duration timeout on streaming API requests', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeUndefined();
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

    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deltas).toEqual(['streamed']);
    expect(result.choices[0]?.message.content).toBe('streamed');
  });

  test('streams thinking and replays signed thinking blocks across tool turns', async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(
          JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
        );
        if (requestBodies.length === 1) {
          return makeEventStreamResponse([
            'event: message_start\n',
            'data: {"type":"message_start","message":{"id":"msg_thinking","model":"claude-sonnet-5","usage":{"input_tokens":4,"output_tokens":0}}}\n\n',
            'event: content_block_start\n',
            'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check"}}\n\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ing"}}\n\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-value"}}\n\n',
            'event: content_block_start\n',
            'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque-value"}}\n\n',
            'event: content_block_start\n',
            'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup","input":{}}}\n\n',
            'event: content_block_delta\n',
            'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"status\\"}"}}\n\n',
            'event: message_delta\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}\n\n',
          ]);
        }
        return new Response(
          JSON.stringify({
            id: 'msg_final',
            model: 'claude-sonnet-5',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'done' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const thinkingDeltas: string[] = [];
    const first = await callAnthropicProviderStream({
      ...baseArgs,
      model: 'anthropic/claude-sonnet-5',
      onTextDelta: () => undefined,
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    });
    const firstMessage = first.choices[0]?.message;

    expect(thinkingDeltas).toEqual(['Check', 'ing']);
    expect(firstMessage?.reasoning_content).toBe('Checking');
    expect(firstMessage?.anthropic_content).toEqual([
      {
        type: 'thinking',
        thinking: 'Checking',
        signature: 'signed-value',
      },
      { type: 'redacted_thinking', data: 'opaque-value' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'lookup',
        input: { query: 'status' },
      },
    ]);

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: firstMessage?.content ?? null,
      tool_calls: firstMessage?.tool_calls,
      anthropic_content: firstMessage?.anthropic_content,
    };
    await callAnthropicProvider({
      ...baseArgs,
      model: 'anthropic/claude-sonnet-5',
      messages: [
        { role: 'user', content: 'check status' },
        assistantMessage,
        { role: 'tool', content: 'ok', tool_call_id: 'tool_1' },
      ],
    });

    expect(requestBodies[0]?.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(requestBodies[1]?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'check status' }] },
      {
        role: 'assistant',
        content: firstMessage?.anthropic_content,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_1',
            content: 'ok',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ]);
  });
});
