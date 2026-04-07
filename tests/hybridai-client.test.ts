import { afterEach, expect, test, vi } from 'vitest';

import {
  callRoutedModel,
  callRoutedModelStream,
} from '../container/src/providers/router.js';

const okResponse = {
  id: 'resp_1',
  model: 'gpt-5-nano',
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'ok',
      },
      finish_reason: 'stop',
    },
  ],
};

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

afterEach(() => {
  vi.restoreAllMocks();
});

test('callRoutedModel forwards max_tokens when provided', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.max_tokens).toBe(4096);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callRoutedModel({
    provider: undefined,
    baseUrl: 'https://hybridai.one',
    apiKey: 'test-key',
    model: 'gpt-5-nano',
    chatbotId: 'bot_1',
    enableRag: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 4096,
  });

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModel omits max_tokens when not provided', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.max_tokens).toBeUndefined();
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  await callRoutedModel({
    provider: undefined,
    baseUrl: 'https://hybridai.one',
    apiKey: 'test-key',
    model: 'gpt-5-nano',
    chatbotId: 'bot_1',
    enableRag: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModel strips the HybridAI display prefix from request models', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('gpt-5-nano');
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  await callRoutedModel({
    provider: undefined,
    baseUrl: 'https://hybridai.one',
    apiKey: 'test-key',
    model: 'hybridai/gpt-5-nano',
    chatbotId: 'bot_1',
    enableRag: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModel routes OpenRouter requests through the OpenAI-compatible transport', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer or-test-key',
      'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
      'X-OpenRouter-Title': 'HybridClaw',
      'X-OpenRouter-Categories': 'cli-agent,general-chat',
      'X-Title': 'HybridClaw',
    });
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('anthropic/claude-sonnet-4');
    expect(body.max_tokens).toBe(512);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callRoutedModel({
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'or-test-key',
    model: 'openrouter/anthropic/claude-sonnet-4',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {
      'HTTP-Referer': 'https://github.com/hybridaione/hybridclaw',
      'X-OpenRouter-Title': 'HybridClaw',
      'X-OpenRouter-Categories': 'cli-agent,general-chat',
      'X-Title': 'HybridClaw',
    },
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 512,
  });

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModelStream forwards stream and max_tokens', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(1024);
    return new Response(JSON.stringify(okResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callRoutedModelStream({
    provider: undefined,
    baseUrl: 'https://hybridai.one',
    apiKey: 'test-key',
    model: 'gpt-5-nano',
    chatbotId: 'bot_1',
    enableRag: true,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    onTextDelta: () => {},
    maxTokens: 1024,
  });

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModelStream parses Codex SSE text deltas and tool calls', async () => {
  const deltas: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('gpt-5-codex');
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('You are a focused coding assistant.');
    expect(body.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.max_output_tokens).toBeUndefined();
    expect(String((init?.headers as Record<string, string>).Accept)).toContain(
      'text/event-stream',
    );

    return makeEventStreamResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex","model":"gpt-5-codex"}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}\n\n',
      'event: response.content_part.added\n',
      'data: {"type":"response.content_part.added","output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":""}}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"Hel"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"lo"}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"{\\"id\\":"}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","delta":"\\"42\\"}"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex","model":"gpt-5-codex","output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup","arguments":"{\\"id\\":\\"42\\"}"}],"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}\n\n',
    ]);
  });
  vi.stubGlobal('fetch', fetchMock);

  const result = await callRoutedModelStream({
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'test-key',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {
      'Chatgpt-Account-Id': 'acct_123',
      'OpenAI-Beta': 'responses=experimental',
    },
    messages: [
      { role: 'system', content: 'You are a focused coding assistant.' },
      { role: 'user', content: 'hello' },
    ],
    tools: [],
    onTextDelta: (delta) => deltas.push(delta),
    maxTokens: 2048,
  });

  expect(deltas).toEqual(['Hel', 'lo']);
  expect(result.model).toBe('gpt-5-codex');
  expect(result.choices[0]?.message.content).toBe('Hello');
  expect(result.choices[0]?.message.tool_calls).toEqual([
    {
      id: 'call_1',
      type: 'function',
      function: {
        name: 'lookup',
        arguments: '{"id":"42"}',
      },
    },
  ]);
  expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  expect(result.usage?.total_tokens).toBe(18);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callRoutedModelStream preserves streamed Codex tool calls when completed output is empty', async () => {
  const fetchMock = vi.fn(async () =>
    makeEventStreamResponse([
      'event: response.created\n',
      'data: {"type":"response.created","response":{"id":"resp_codex","model":"gpt-5.3-codex-spark"}}\n\n',
      'event: response.output_item.added\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":""}}\n\n',
      'event: response.function_call_arguments.delta\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"path\\":\\"/app/file.txt\\"}"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"id":"resp_codex","model":"gpt-5.3-codex-spark","output":[],"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}\n\n',
    ]),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await callRoutedModelStream({
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'test-key',
    model: 'openai-codex/gpt-5.3-codex-spark',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {
      'Chatgpt-Account-Id': 'acct_123',
      'OpenAI-Beta': 'responses=experimental',
    },
    messages: [{ role: 'user', content: 'read the file' }],
    tools: [],
    onTextDelta: () => undefined,
  });

  expect(result.choices[0]?.message.tool_calls).toEqual([
    {
      id: 'call_1',
      type: 'function',
      function: {
        name: 'read',
        arguments: '{"path":"/app/file.txt"}',
      },
    },
  ]);
  expect(result.choices[0]?.finish_reason).toBe('tool_calls');
  expect(result.usage?.total_tokens).toBe(18);
});

test('callRoutedModel sends Codex instructions and omits system messages from input', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;

    expect(body.model).toBe('gpt-5-codex');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe('Follow repository conventions exactly.');
    expect(body.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.max_output_tokens).toBeUndefined();
    expect(String((init?.headers as Record<string, string>).Accept)).toContain(
      'text/event-stream',
    );

    return new Response(
      JSON.stringify({
        id: 'resp_codex',
        model: 'gpt-5-codex',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
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

  const result = await callRoutedModel({
    provider: 'openai-codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'test-key',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    enableRag: false,
    requestHeaders: {},
    messages: [
      { role: 'system', content: 'Follow repository conventions exactly.' },
      { role: 'user', content: 'hello' },
    ],
    tools: [],
  });

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
