import { afterEach, describe, expect, test, vi } from 'vitest';

import { callAuxiliaryModel } from '../container/src/providers/auxiliary.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('container auxiliary router', () => {
  test('calls the configured vision task model instead of the fallback model context', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('http://127.0.0.1:1234/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body).toMatchObject({
          model: 'qwen/qwen2.5-vl',
          max_tokens: 321,
        });
        return new Response(
          JSON.stringify({
            id: 'resp_aux',
            model: 'qwen/qwen2.5-vl',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Detected via auxiliary wrapper.',
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

    const result = await callAuxiliaryModel({
      task: 'vision',
      taskModels: {
        vision: {
          provider: 'lmstudio',
          baseUrl: 'http://127.0.0.1:1234',
          apiKey: '',
          model: 'lmstudio/qwen/qwen2.5-vl',
          chatbotId: '',
          requestHeaders: {},
          isLocal: true,
          maxTokens: 321,
        },
      },
      fallbackContext: {
        provider: 'hybridai',
        baseUrl: 'https://hybridai.one',
        apiKey: 'fallback-key',
        model: 'gpt-5-nano',
        chatbotId: 'bot_123',
        requestHeaders: {},
      },
      question: 'What is in this image?',
      imageDataUrl: 'data:image/jpeg;base64,ZmFrZQ==',
      toolName: 'vision_analyze',
    });

    expect(result).toMatchObject({
      model: 'lmstudio/qwen/qwen2.5-vl',
      analysis: 'Detected via auxiliary wrapper.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps browser-specific missing context wording when no task model is available', async () => {
    await expect(
      callAuxiliaryModel({
        task: 'vision',
        fallbackContext: {
          provider: 'openrouter',
          baseUrl: '',
          apiKey: '',
          model: '',
          chatbotId: '',
          requestHeaders: {},
        },
        question: 'What is on the page?',
        imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
        toolName: 'browser_vision',
        missingContextSource: 'active request',
      }),
    ).rejects.toThrow(
      'browser_vision is not configured: missing active request base URL context.',
    );
  });

  test('routes compression text calls through the configured auxiliary model', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('http://127.0.0.1:8000/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body).toMatchObject({
          model: 'mistral-small',
          max_tokens: 222,
        });
        return new Response(
          JSON.stringify({
            id: 'resp_aux_text',
            model: 'mistral-small',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Compressed via text auxiliary wrapper.',
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

    const result = await callAuxiliaryModel({
      task: 'compression',
      taskModels: {
        compression: {
          provider: 'vllm',
          baseUrl: 'http://127.0.0.1:8000/v1',
          apiKey: '',
          model: 'vllm/mistral-small',
          chatbotId: '',
          requestHeaders: {},
          isLocal: true,
          maxTokens: 222,
        },
      },
      fallbackContext: {
        provider: 'hybridai',
        baseUrl: 'https://hybridai.one',
        apiKey: 'fallback-key',
        model: 'gpt-5-nano',
        chatbotId: 'bot_123',
        requestHeaders: {},
      },
      messages: [{ role: 'user', content: 'Summarize this transcript.' }],
    });

    expect(result).toMatchObject({
      model: 'vllm/mistral-small',
      content: 'Compressed via text auxiliary wrapper.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
