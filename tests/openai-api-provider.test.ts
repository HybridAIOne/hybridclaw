import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callOpenAIResponsesProvider,
  callOpenAIResponsesProviderStream,
} from '../container/src/providers/openai-codex.js';
import type { ChatMessage, ToolDefinition } from '../container/src/types.js';

const messages: ChatMessage[] = [
  { role: 'system', content: 'Be concise.' },
  { role: 'user', content: 'Check the weather.' },
];
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];
const baseArgs = {
  provider: 'openai' as const,
  providerMethod: 'api-key',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'openai-key',
  model: 'openai/gpt-5.6-sol',
  chatbotId: '',
  enableRag: false,
  requestHeaders: {},
  messages,
  tools,
  maxTokens: 512,
  isLocal: false,
  contextWindow: 1_050_000,
  thinkingFormat: undefined,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OpenAI API provider', () => {
  test('sends Responses API requests with tools and adapts function calls', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer openai-key',
      );
      const body = JSON.parse(String(init?.body || '{}')) as Record<
        string,
        unknown
      >;
      expect(body).toMatchObject({
        model: 'gpt-5.6-sol',
        store: false,
        stream: true,
        instructions: 'Be concise.',
        max_output_tokens: 512,
        include: ['reasoning.encrypted_content'],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      });
      expect(body.input).toEqual([
        { role: 'user', content: 'Check the weather.' },
      ]);
      return new Response(
        JSON.stringify({
          id: 'resp_openai_1',
          model: 'gpt-5.6-sol',
          output: [
            {
              type: 'reasoning',
              id: 'rs_1',
              encrypted_content: 'encrypted-reasoning-state',
              summary: [],
            },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'get_weather',
              arguments: '{"city":"Berlin"}',
            },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await callOpenAIResponsesProvider(baseArgs);

    expect(response.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"city":"Berlin"}',
        },
      },
    ]);
    expect(response.choices[0]?.finish_reason).toBe('tool_calls');
    expect(response.choices[0]?.message.openai_response_items).toEqual([
      {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'encrypted-reasoning-state',
        summary: [],
      },
    ]);

    fetchMock.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as {
          input?: unknown[];
        };
        expect(body.input).toEqual([
          {
            type: 'reasoning',
            id: 'rs_1',
            encrypted_content: 'encrypted-reasoning-state',
            summary: [],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'get_weather',
            arguments: '{"city":"Berlin"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Sunny',
          },
        ]);
        return new Response(
          JSON.stringify({
            id: 'resp_openai_2',
            model: 'gpt-5.6-sol',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'It is sunny.' }],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );

    const continuation = await callOpenAIResponsesProvider({
      ...baseArgs,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: response.choices[0]?.message.tool_calls,
          openai_response_items:
            response.choices[0]?.message.openai_response_items,
        },
        {
          role: 'tool',
          content: 'Sunny',
          tool_call_id: 'call_1',
        },
      ],
    });
    expect(continuation.choices[0]?.message.content).toBe('It is sunny.');
  });

  test('streams text deltas and reports OpenAI-specific empty responses', async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: response.output_text.delta\r\n' +
                    'data: {"type":"response.output_text.delta","delta":"Hello"}\r\n\r\n' +
                    'event: response.completed\r\n' +
                    'data: {"type":"response.completed","response":{"id":"resp_openai_2","model":"gpt-5.6-sol","output":[]}}\r\n\r\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          },
        ),
      ),
    );
    const deltas: string[] = [];

    const response = await callOpenAIResponsesProviderStream({
      ...baseArgs,
      tools: [],
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['Hello']);
    expect(response.choices[0]?.message.content).toBe('Hello');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_openai_3',
              model: 'gpt-5.6-sol',
              output: [],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    await expect(
      callOpenAIResponsesProvider({ ...baseArgs, tools: [] }),
    ).rejects.toThrow('OpenAI Responses API returned no output items');
  });
});
