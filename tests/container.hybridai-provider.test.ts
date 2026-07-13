import { afterEach, describe, expect, test, vi } from 'vitest';
import { callHybridAIProviderStream } from '../container/src/providers/hybridai.js';
import type { NormalizedStreamCallArgs } from '../container/src/providers/shared.js';
import type { ChatCompletionResponse } from '../container/src/types.js';

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

const baseStreamArgs = {
  provider: 'hybridai',
  baseUrl: 'https://api.hybridai.one',
  apiKey: 'test-key',
  model: 'hybridai/gpt-5-nano',
  chatbotId: '',
  enableRag: false,
  requestHeaders: undefined,
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  maxTokens: 128,
  isLocal: false,
  contextWindow: 1_000_000,
  thinkingFormat: undefined,
} satisfies Omit<NormalizedStreamCallArgs, 'onTextDelta'>;

type StreamPayload = Record<string, unknown> | '[DONE]';

async function streamPayloads(payloads: StreamPayload[]): Promise<{
  textDeltas: string[];
  result: ChatCompletionResponse;
}> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      makeEventStreamResponse(
        payloads.map(
          (payload) =>
            `data: ${payload === '[DONE]' ? payload : JSON.stringify(payload)}\n\n`,
        ),
      ),
    ),
  );

  const textDeltas: string[] = [];
  const result = await callHybridAIProviderStream({
    ...baseStreamArgs,
    onTextDelta: (delta) => textDeltas.push(delta),
  });
  return { textDeltas, result };
}

function expectStreamText(
  streamed: {
    textDeltas: string[];
    result: ChatCompletionResponse;
  },
  expectedDeltas: string[],
  expectedContent: string,
): void {
  expect(streamed.textDeltas).toEqual(expectedDeltas);
  expect(streamed.textDeltas.join('')).toBe(expectedContent);
  expect(streamed.result.choices[0]?.message.content).toBe(expectedContent);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HybridAI container provider', () => {
  test('keeps delta-only streams unchanged, including repeated text', async () => {
    const streamed = await streamPayloads([
      { choices: [{ delta: { content: 'Ja' } }] },
      { choices: [{ delta: { content: 'Ja' }, finish_reason: 'stop' }] },
      '[DONE]',
    ]);

    expectStreamText(streamed, ['Ja', 'Ja'], 'JaJa');
  });

  test('emits only new suffixes from cumulative message snapshots', async () => {
    const streamed = await streamPayloads([
      {
        choices: [
          { message: { content: 'Alles' }, delta: { content: 'Alles' } },
        ],
      },
      {
        choices: [
          {
            message: { content: 'Alles klar' },
            delta: { content: ' klar' },
          },
        ],
      },
      {
        choices: [
          {
            message: { content: 'Alles klar!' },
            delta: { content: '!' },
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    ]);

    expectStreamText(streamed, ['Alles', ' klar', '!'], 'Alles klar!');
  });

  test('does not duplicate a final message snapshot and delta', async () => {
    const streamed = await streamPayloads([
      { choices: [{ delta: { content: 'Alles klar' } }] },
      {
        choices: [
          {
            message: { content: 'Alles klar' },
            delta: { content: 'Alles klar' },
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    ]);

    expectStreamText(streamed, ['Alles klar'], 'Alles klar');
  });

  test('does not let empty message content suppress a valid delta', async () => {
    const streamed = await streamPayloads([
      {
        choices: [
          {
            message: { content: '' },
            delta: { content: 'Alles klar' },
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    ]);

    expectStreamText(streamed, ['Alles klar'], 'Alles klar');
  });

  test('preserves tool calls before a final text response without duplication', async () => {
    const streamed = await streamPayloads([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'complete_onboarding',
                    arguments: '{"confirmed":',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'true}' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { content: 'Alles klar' } }] },
      {
        usage: {
          prompt_tokens: 12,
          completion_tokens: 2,
          total_tokens: 14,
        },
        choices: [
          {
            message: { content: 'Alles klar' },
            delta: { content: 'Alles klar' },
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    ]);

    expectStreamText(streamed, ['Alles klar'], 'Alles klar');
    expect(streamed.result.choices[0]?.message.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'complete_onboarding',
          arguments: '{"confirmed":true}',
        },
      },
    ]);
    expect(streamed.result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 2,
      total_tokens: 14,
    });
  });

  test('streams structured reasoning separately from visible content', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return makeEventStreamResponse([
          'data: {"id":"response_1","model":"anthropic/claude-sonnet-5","choices":[{"delta":{"reasoning_content":"Plan"}}]}\n\n',
          'data: {"choices":[{"delta":{"reasoning":" carefully"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
          'data: {"choices":[{"delta":{"anthropic_content":[{"type":"thinking","thinking":"Plan carefully","signature":"signed-value"},{"type":"text","text":"Answer"}]}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      }),
    );

    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const result = await callHybridAIProviderStream({
      ...baseStreamArgs,
      model: 'hybridai/anthropic/claude-sonnet-5',
      onTextDelta: (delta) => textDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    });

    expect(thinkingDeltas).toEqual(['Plan', ' carefully']);
    expect(textDeltas).toEqual(['Answer']);
    expect(requestBody?.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(result.choices[0]?.message.reasoning_content).toBe(
      'Plan carefully',
    );
    expect(result.choices[0]?.message.content).toBe('Answer');
    expect(result.choices[0]?.message.anthropic_content).toEqual([
      {
        type: 'thinking',
        thinking: 'Plan carefully',
        signature: 'signed-value',
      },
      { type: 'text', text: 'Answer' },
    ]);
  });
});
