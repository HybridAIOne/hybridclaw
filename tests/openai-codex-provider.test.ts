import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  callOpenAICodexProvider,
  callOpenAICodexProviderStream,
} from '../container/src/providers/openai-codex.js';
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
  provider: 'openai-codex' as const,
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  apiKey: 'codex-key',
  model: 'openai-codex/gpt-5.4',
  chatbotId: '',
  enableRag: false,
  requestHeaders: { 'OpenAI-Beta': 'responses=experimental' },
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

describe('OpenAI Codex provider', () => {
  test('uses top-level output_text when output is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_1',
              model: 'gpt-5.4',
              output: [],
              output_text: 'Created llm-wiki',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    const result = await callOpenAICodexProvider(baseArgs);

    expect(result.choices[0]?.message.content).toBe('Created llm-wiki');
  });

  test('backfills empty completed stream payloads from streamed text deltas', async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'event: response.output_text.delta\r\n',
          'data: {"type":"response.output_text.delta","delta":"mkdir "}\r\n\r\n',
          'event: response.output_text.delta\r\n',
          'data: {"type":"response.output_text.delta","delta":"llm-wiki"}\r\n\r\n',
          'event: response.completed\r\n',
          'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.4","output":[]}}\r\n\r\n',
        ]),
      ),
    );

    const result = await callOpenAICodexProviderStream({
      ...baseArgs,
      onTextDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['mkdir ', 'llm-wiki']);
    expect(result.choices[0]?.message.content).toBe('mkdir llm-wiki');
  });

  test('treats response.incomplete as terminal when streamed output is recoverable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        makeEventStreamResponse([
          'event: response.output_text.delta\r\n',
          'data: {"type":"response.output_text.delta","delta":"ls -la"}\r\n\r\n',
          'event: response.incomplete\r\n',
          'data: {"type":"response.incomplete","response":{"id":"resp_3","model":"gpt-5.4","status":"incomplete","output":[]}}\r\n\r\n',
        ]),
      ),
    );

    const result = await callOpenAICodexProviderStream({
      ...baseArgs,
      onTextDelta: () => undefined,
    });

    expect(result.choices[0]?.message.content).toBe('ls -la');
  });

  test('fails explicitly when Codex returns no output at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_4',
              model: 'gpt-5.4',
              output: [],
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
      ),
    );

    await expect(callOpenAICodexProvider(baseArgs)).rejects.toThrow(
      'Codex Responses API returned no output items',
    );
  });
});
