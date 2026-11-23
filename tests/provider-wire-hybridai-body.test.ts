import { buildHybridAIRequestBody } from '@hybridclaw/shared/provider-wire/hybridai-body';
import { describe, expect, it, vi } from 'vitest';
import {
  callOpenAICompatibleModel,
  callOpenAICompatibleModelStream,
} from '../src/gateway/openai-compatible-model.js';
import { useCleanMocks } from './test-utils.js';

const messages = [{ role: 'user', content: 'hi' }];
const tool = { type: 'function', function: { name: 'shell' } };

describe('HybridAI request body', () => {
  it.each([
    {
      label: 'minimal body',
      params: { model: 'hybridai/gpt-5-nano', tools: [] },
      expected: { model: 'gpt-5-nano', messages },
    },
    {
      label: 'chatbot and RAG',
      params: {
        model: 'gpt-5-nano',
        tools: [],
        chatbotId: 'bot_a',
        enableRag: true,
      },
      expected: {
        model: 'gpt-5-nano',
        messages,
        chatbot_id: 'bot_a',
        enable_rag: true,
      },
    },
    {
      label: 'tools with a default choice',
      params: { model: 'gpt-5-nano', tools: [tool] },
      expected: {
        model: 'gpt-5-nano',
        messages,
        tools: [tool],
        tool_choice: 'auto',
      },
    },
    {
      label: 'tools with an explicit choice',
      params: { model: 'gpt-5-nano', tools: [tool], toolChoice: 'required' },
      expected: {
        model: 'gpt-5-nano',
        messages,
        tools: [tool],
        tool_choice: 'required',
      },
    },
    {
      label: 'floored max tokens',
      params: { model: 'gpt-5-nano', tools: [], maxTokens: 512.7 },
      expected: { model: 'gpt-5-nano', messages, max_tokens: 512 },
    },
    {
      label: 'non-positive max tokens dropped',
      params: { model: 'gpt-5-nano', tools: [], maxTokens: 0 },
      expected: { model: 'gpt-5-nano', messages },
    },
    {
      label: 'reasoning effort forwarded without template kwargs',
      params: {
        model: 'qwen/qwen3.8-27b',
        tools: [],
        reasoningEffort: 'none' as const,
      },
      expected: {
        model: 'qwen/qwen3.8-27b',
        messages,
        reasoning_effort: 'none',
      },
    },
    {
      label: 'unknown reasoning effort dropped',
      params: {
        model: 'gpt-5-nano',
        tools: [],
        reasoningEffort: 'extreme' as never,
      },
      expected: { model: 'gpt-5-nano', messages },
    },
    {
      label: 'adaptive thinking when requested',
      params: {
        model: 'hybridai/anthropic/claude-sonnet-4-6',
        tools: [],
        adaptiveThinking: true,
      },
      expected: {
        model: 'anthropic/claude-sonnet-4-6',
        messages,
        thinking: { type: 'adaptive', display: 'summarized' },
      },
    },
    {
      label: 'no adaptive thinking unless requested',
      params: { model: 'hybridai/anthropic/claude-sonnet-4-6', tools: [] },
      expected: { model: 'anthropic/claude-sonnet-4-6', messages },
    },
    {
      label: 'reasoning effort instead of adaptive thinking',
      params: {
        model: 'hybridai/anthropic/claude-opus-5-5',
        tools: [],
        reasoningEffort: 'low' as const,
        adaptiveThinking: true,
      },
      expected: {
        model: 'anthropic/claude-opus-5-5',
        messages,
        reasoning_effort: 'low',
      },
    },
  ])('$label', ({ params, expected }) => {
    expect(buildHybridAIRequestBody({ messages, ...params })).toEqual(
      expected,
    );
  });
});

describe('gateway HybridAI model client', () => {
  useCleanMocks();

  it('sends max_tokens like the worker, without adaptive thinking', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'anthropic/claude-sonnet-4-6',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await callOpenAICompatibleModel({
      runtime: {
        provider: 'hybridai',
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
        chatbotId: '',
        enableRag: false,
        requestHeaders: {},
        agentId: 'main',
        maxTokens: 4096,
      },
      model: 'hybridai/anthropic/claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    expect(bodies[0]).toMatchObject({
      model: 'anthropic/claude-sonnet-4-6',
      max_tokens: 4096,
    });
    expect(bodies[0]).not.toHaveProperty('thinking');
  });

  it('rejects a stream that reports a provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"error":{"message":"upstream overloaded"}}\n\ndata: [DONE]\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } },
          ),
      ),
    );

    await expect(
      callOpenAICompatibleModelStream({
        runtime: {
          provider: 'hybridai',
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
          chatbotId: '',
          enableRag: false,
          requestHeaders: {},
          agentId: 'main',
        },
        model: 'hybridai/anthropic/claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        onTextDelta: () => {},
      }),
    ).rejects.toThrow('upstream overloaded');
  });
});
