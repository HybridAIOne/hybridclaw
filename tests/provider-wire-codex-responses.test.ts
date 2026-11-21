import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import {
  adaptResponsesPayload,
  buildResponsesRequestBody,
  buildResponsesStreamResponse,
  consumeResponsesStreamEvent,
  convertMessageToResponsesInput,
  createResponsesStreamState,
  normalizeCodexModelName,
} from '@hybridclaw/shared/provider-wire/codex-responses';
import { describe, expect, it, vi } from 'vitest';
import { callOpenAICompatibleModel } from '../src/gateway/openai-compatible-model.js';
import { callAuxiliaryModel } from '../src/providers/auxiliary.js';
import { useCleanMocks } from './test-utils.js';

vi.mock('../src/providers/task-routing.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/providers/task-routing.js')
  >()),
  resolveTaskModelPolicy: vi.fn(async () => ({
    provider: 'openai-codex',
    baseUrl: 'https://example.com/codex',
    apiKey: 'test-key',
    requestHeaders: {},
    isLocal: false,
    model: 'openai-codex/gpt-5.4-mini',
    chatbotId: '',
  })),
}));

const reasoningItem = { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' };
const toolCall = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'shell', arguments: '{"command":"ls"}' },
};

describe('Responses codec', () => {
  it.each([
    ['openai-codex/gpt-5.4', 'gpt-5.4'],
    ['openai/gpt-5.4', 'gpt-5.4'],
    ['OPENAI/gpt-5.4', 'gpt-5.4'],
    ['openai-codex/openai/gpt-5.4', 'openai/gpt-5.4'],
    [' gpt-5.4 ', 'gpt-5.4'],
    ['openai-codex/', 'openai-codex/'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCodexModelName(input)).toBe(expected);
  });

  it.each<[string, ChatMessage, Array<Record<string, unknown>>]>([
    ['drops system messages', { role: 'system', content: 'be brief' }, []],
    [
      'maps tool results to function_call_output',
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }],
    ],
    [
      'keeps text, image, and file parts',
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          {
            type: 'file',
            file: { filename: 'a.pdf', file_data: 'data:application/pdf,AA' },
          },
        ],
      },
      [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'read this' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA' },
            {
              type: 'input_file',
              filename: 'a.pdf',
              file_data: 'data:application/pdf,AA',
            },
          ],
        },
      ],
    ],
    [
      'replays reasoning items ahead of their tool calls',
      {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall],
        openai_response_items: [reasoningItem],
      },
      [
        reasoningItem,
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"command":"ls"}',
        },
      ],
    ],
    ['drops blank text', { role: 'user', content: '   ' }, []],
  ])('%s', (_label, message, expected) => {
    expect(convertMessageToResponsesInput(message)).toEqual(expected);
  });

  it.each([
    {
      label: 'Codex with a session key',
      params: { provider: 'openai-codex', promptCacheKey: 'session-a' },
      expected: {
        prompt_cache_key: 'session-a',
        instructions: 'You are Codex, a coding assistant.',
      },
      absent: ['include', 'max_output_tokens'],
    },
    {
      label: 'OpenAI with max tokens',
      params: { provider: 'openai', maxTokens: 64 },
      expected: {
        max_output_tokens: 64,
        include: ['reasoning.encrypted_content'],
        instructions: 'You are a helpful assistant.',
      },
      absent: ['prompt_cache_key'],
    },
  ])('builds the $label request body', ({ params, expected, absent }) => {
    const body = buildResponsesRequestBody({
      model: 'openai/gpt-5.4',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      ...params,
    });
    expect(body).toMatchObject({ model: 'gpt-5.4', store: false, ...expected });
    for (const key of absent) expect(body).not.toHaveProperty(key);
  });

  it.each([
    [undefined, 'auto'],
    ['required' as const, 'required'],
    [
      { type: 'function' as const, function: { name: 'shell' } },
      { type: 'function', name: 'shell' },
    ],
  ])('maps tool choice %j to %j', (toolChoice, expected) => {
    const body = buildResponsesRequestBody({
      provider: 'openai-codex',
      model: 'gpt-5.4',
      messages: [],
      tools: [{ function: { name: 'shell', parameters: {} } }],
      toolChoice,
    });
    expect(body.tool_choice).toEqual(expected);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'shell',
        description: undefined,
        parameters: {},
      },
    ]);
  });

  it('adapts output items into one completion', () => {
    const completion = adaptResponsesPayload(
      {
        id: 'resp_1',
        status: 'incomplete',
        output: [
          reasoningItem,
          { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
          { type: 'function_call', call_id: 'call_1', name: 'shell' },
        ],
        usage: { input_tokens: 3 },
      },
      'openai-codex/gpt-5.4',
    );
    expect(completion).toEqual({
      id: 'resp_1',
      model: 'gpt-5.4',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hi',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'shell', arguments: '{}' },
              },
            ],
            openai_response_items: [reasoningItem],
          },
          finish_reason: 'length',
        },
      ],
      usage: { input_tokens: 3 },
    });
  });

  it('reduces stream events and backfills an empty completed output', () => {
    const state = createResponsesStreamState('gpt-5.4');
    const deltas: string[] = [];
    const handlers = { onTextDelta: (delta: string) => deltas.push(delta) };
    const events: Array<[string | null, Record<string, unknown>]> = [
      [null, { type: 'response.output_text.delta', delta: 'Hel' }],
      ['response.output_text.delta', { delta: 'lo' }],
      [
        null,
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'function_call', id: 'fc_1', call_id: 'call_1' },
        },
      ],
      [
        null,
        {
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: '{}',
        },
      ],
    ];
    for (const [eventName, payload] of events) {
      expect(
        consumeResponsesStreamEvent(
          JSON.stringify(payload),
          eventName,
          state,
          handlers,
        ),
      ).toBe(false);
    }
    expect(
      consumeResponsesStreamEvent(
        JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_1', output: [] },
        }),
        null,
        state,
        handlers,
      ),
    ).toBe(true);

    const completion = buildResponsesStreamResponse(state, 'gpt-5.4');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(completion.id).toBe('resp_1');
    expect(completion.choices[0]?.message.content).toBe('Hello');
    expect(completion.choices[0]?.message.tool_calls?.[0]?.id).toBe('call_1');
  });

  it.each([
    [{ type: 'error', message: 'boom' }, 'boom'],
    [
      { type: 'response.failed', response: { error: { code: 'quota' } } },
      'quota',
    ],
  ])('throws on stream error event %j', (payload, message) => {
    expect(() =>
      consumeResponsesStreamEvent(
        JSON.stringify(payload),
        null,
        createResponsesStreamState('gpt-5.4'),
        { onTextDelta: () => undefined },
      ),
    ).toThrow(message);
  });
});

describe('gateway Responses callers', () => {
  useCleanMocks();

  const codexRuntime = {
    provider: 'openai-codex' as const,
    apiKey: 'test-key',
    baseUrl: 'https://example.com/codex',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    agentId: 'main',
    isLocal: false,
    contextWindow: 200_000,
    thinkingFormat: undefined,
  };
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'summarize' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        {
          type: 'file',
          file: { filename: 'a.pdf', file_data: 'data:application/pdf,AA' },
        },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall],
      openai_response_items: [reasoningItem],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'done' },
  ];

  function stubResponsesFetch(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    return bodies;
  }

  it('sends file parts, images, and reasoning replay from the gateway model client', async () => {
    const bodies = stubResponsesFetch();
    await callOpenAICompatibleModel({
      runtime: codexRuntime,
      model: 'openai/gpt-5.4',
      messages,
      tools: [],
    });
    expect(bodies[0]?.model).toBe('gpt-5.4');
    expect(bodies[0]?.input).toEqual(
      messages.flatMap(convertMessageToResponsesInput),
    );
  });

  it('sends images and file parts from the auxiliary client', async () => {
    const bodies = stubResponsesFetch();
    const result = await callAuxiliaryModel({
      task: 'compression',
      messages,
      allowFallback: false,
    });
    expect(result.content).toBe('ok');
    expect(bodies[0]?.input).toEqual(
      messages.flatMap(convertMessageToResponsesInput),
    );
  });
});
