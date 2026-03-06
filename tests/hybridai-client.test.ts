import { afterEach, expect, test, vi } from 'vitest';

import {
  callHybridAI,
  callHybridAIStream,
} from '../container/src/model-client.js';

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

test('callHybridAI forwards max_tokens when provided', async () => {
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

  const result = await callHybridAI(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
    4096,
  );

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callHybridAI omits max_tokens when not provided', async () => {
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

  await callHybridAI(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callHybridAIStream forwards stream and max_tokens', async () => {
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

  const result = await callHybridAIStream(
    'https://hybridai.one',
    'test-key',
    'gpt-5-nano',
    'bot_1',
    true,
    [{ role: 'user', content: 'hello' }],
    [],
    () => {},
    1024,
  );

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('callHybridAIStream parses Codex SSE text deltas and tool calls', async () => {
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

  const result = await callHybridAIStream(
    'openai-codex',
    'https://chatgpt.com/backend-api/codex',
    'test-key',
    'openai-codex/gpt-5-codex',
    '',
    false,
    {
      'Chatgpt-Account-Id': 'acct_123',
      'OpenAI-Beta': 'responses=experimental',
    },
    [
      { role: 'system', content: 'You are a focused coding assistant.' },
      { role: 'user', content: 'hello' },
    ],
    [],
    (delta) => deltas.push(delta),
    2048,
  );

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

test('callHybridAI sends Codex instructions and omits system messages from input', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<
      string,
      unknown
    >;

    expect(body.model).toBe('gpt-5-codex');
    expect(body.store).toBe(false);
    expect(body.instructions).toBe('Follow repository conventions exactly.');
    expect(body.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.max_output_tokens).toBeUndefined();

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

  const result = await callHybridAI(
    'openai-codex',
    'https://chatgpt.com/backend-api/codex',
    'test-key',
    'openai-codex/gpt-5-codex',
    '',
    false,
    {},
    [
      { role: 'system', content: 'Follow repository conventions exactly.' },
      { role: 'user', content: 'hello' },
    ],
    [],
  );

  expect(result.choices[0]?.message.content).toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
