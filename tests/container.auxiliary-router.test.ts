import { afterEach, describe, expect, test, vi } from 'vitest';

import { callAuxiliaryModel } from '../container/src/providers/auxiliary.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('../container/src/providers/router.js');
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
        });
        expect(body.max_tokens).toBeUndefined();
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

  test('preserves the original vision failure as the error cause', async () => {
    const originalError = new Error(
      'This model does not support image inputs.',
    );
    vi.doMock('../container/src/providers/router.js', () => ({
      callRoutedModel: vi.fn(),
      callVisionProviderModel: vi.fn(async () => {
        throw originalError;
      }),
      extractResponseTextContent: vi.fn(),
    }));

    const { callAuxiliaryModel: callFreshAuxiliaryModel } = await import(
      '../container/src/providers/auxiliary.js'
    );

    try {
      await callFreshAuxiliaryModel({
        task: 'vision',
        fallbackContext: {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'test-key',
          model: 'openrouter/example/visionless-model',
          chatbotId: '',
          requestHeaders: {},
        },
        question: 'What is in this image?',
        imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
        toolName: 'vision_analyze',
      });
      throw new Error('Expected callAuxiliaryModel to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(
        'Model "openrouter/example/visionless-model" does not support vision/image inputs. Configure a vision-capable model via auxiliaryModels.vision in runtime config, or use a vision-enabled session model. Original error: This model does not support image inputs.',
      );
      expect((err as Error & { cause?: unknown }).cause).toBe(originalError);
    }
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
        });
        expect(body.max_tokens).toBeUndefined();
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

  test('omits max_tokens for non-Anthropic OpenRouter fallback text calls', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.max_tokens).toBeUndefined();
        return new Response(
          JSON.stringify({
            id: 'resp_aux_text',
            model: 'qwen/qwen3.5-27b',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'OpenRouter fallback response.',
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
      fallbackContext: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'fallback-key',
        model: 'openrouter/qwen/qwen3.5-27b',
        chatbotId: '',
        requestHeaders: {},
      },
      messages: [{ role: 'user', content: 'Summarize this transcript.' }],
      maxTokens: 222,
    });

    expect(result).toMatchObject({
      model: 'openrouter/qwen/qwen3.5-27b',
      content: 'OpenRouter fallback response.',
    });
  });

  test('falls back to 32000 max_tokens for Anthropic OpenRouter fallback text calls', async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe('https://openrouter.ai/api/v1/chat/completions');
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.max_tokens).toBe(32_000);
        return new Response(
          JSON.stringify({
            id: 'resp_aux_text',
            model: 'anthropic/claude-sonnet-4',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Anthropic fallback response.',
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
      fallbackContext: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'fallback-key',
        model: 'openrouter/anthropic/claude-sonnet-4',
        chatbotId: '',
        requestHeaders: {},
      },
      messages: [{ role: 'user', content: 'Summarize this transcript.' }],
      maxTokens: 222,
    });

    expect(result).toMatchObject({
      model: 'openrouter/anthropic/claude-sonnet-4',
      content: 'Anthropic fallback response.',
    });
  });
});
