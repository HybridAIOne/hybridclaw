import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  callRoutedModel,
  callVisionProviderModel,
} from '../container/src/providers/router.js';
import type { ChatMessage } from '../container/src/types.js';

const baseMessages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('container model router', () => {
  test('routes OpenRouter text calls through the OpenAI-compatible provider path', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer openrouter-test-key',
          'X-Title': 'HybridClaw',
        });
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('anthropic/claude-sonnet-4');
        expect(body.messages).toEqual(baseMessages);
        return new Response(
          JSON.stringify({
            id: 'resp_1',
            model: 'anthropic/claude-sonnet-4',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'ok',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await callRoutedModel({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'openrouter-test-key',
      model: 'openrouter/anthropic/claude-sonnet-4',
      chatbotId: '',
      requestHeaders: { 'X-Title': 'HybridClaw' },
      messages: baseMessages,
      tools: [],
      maxTokens: 128,
    });

    expect(response.choices[0]?.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('routes Codex vision calls through the shared router', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://chatgpt.com/backend-api/codex/responses');
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer codex-test-key',
        });
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('gpt-5-codex');
        expect(body.instructions).toContain('Analyze the provided image');
        expect(body.input).toEqual([
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'What does this chart show?' },
              {
                type: 'input_image',
                image_url: 'data:image/png;base64,ZmFrZQ==',
              },
            ],
          },
        ]);
        return new Response(
          JSON.stringify({
            id: 'resp_codex',
            model: 'gpt-5-codex',
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'A bar chart.' }],
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callVisionProviderModel({
      provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: 'codex-test-key',
      model: 'openai-codex/gpt-5-codex',
      chatbotId: '',
      question: 'What does this chart show?',
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    });

    expect(result).toMatchObject({
      model: 'openai-codex/gpt-5-codex',
      analysis: 'A bar chart.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('adds /v1 for LM Studio vision contexts without a version suffix', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('http://127.0.0.1:1234/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.model).toBe('qwen/qwen2.5-vl');
        expect(body.messages).toEqual([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' },
              },
            ],
          },
        ]);
        return new Response(
          JSON.stringify({
            id: 'resp_vision',
            model: 'qwen/qwen2.5-vl',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Detected via LM Studio.' }],
                },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callVisionProviderModel({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: '',
      model: 'lmstudio/qwen/qwen2.5-vl',
      chatbotId: '',
      question: 'What is in this image?',
      imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
    });

    expect(result).toMatchObject({
      model: 'lmstudio/qwen/qwen2.5-vl',
      analysis: 'Detected via LM Studio.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
