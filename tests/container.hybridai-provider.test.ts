import { afterEach, describe, expect, test, vi } from 'vitest';
import { callHybridAIProviderStream } from '../container/src/providers/hybridai.js';

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
  vi.unstubAllGlobals();
});

describe('HybridAI container provider', () => {
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
      provider: 'hybridai',
      baseUrl: 'https://api.hybridai.one',
      apiKey: 'test-key',
      model: 'hybridai/anthropic/claude-sonnet-5',
      chatbotId: '',
      enableRag: false,
      requestHeaders: undefined,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      onTextDelta: (delta) => textDeltas.push(delta),
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
      maxTokens: 128,
      isLocal: false,
      contextWindow: 1_000_000,
      thinkingFormat: undefined,
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
