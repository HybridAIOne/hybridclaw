import { describe, expect, test } from 'vitest';

import { getProviderContextError } from '../container/shared/provider-context.js';

describe('provider context validation', () => {
  test('returns a tool-specific error when base URL is missing', () => {
    expect(
      getProviderContextError({
        provider: 'lmstudio',
        baseUrl: '',
        apiKey: '',
        model: 'lmstudio/qwen/qwen2.5-instruct',
        chatbotId: '',
        toolName: 'compression',
      }),
    ).toBe('compression is not configured: missing base URL context.');
  });

  test('requires an API key for OpenRouter contexts', () => {
    expect(
      getProviderContextError({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: 'openrouter/anthropic/claude-sonnet-4',
        chatbotId: '',
        toolName: 'compression',
      }),
    ).toBe('compression is not configured: missing API key context.');
  });

  test('requires an API key for Hugging Face contexts', () => {
    expect(
      getProviderContextError({
        provider: 'huggingface',
        baseUrl: 'https://router.huggingface.co/v1',
        apiKey: '',
        model: 'huggingface/meta-llama/Llama-3.1-8B-Instruct',
        chatbotId: '',
        toolName: 'compression',
      }),
    ).toBe('compression is not configured: missing API key context.');
  });

  test('requires chatbot_id for HybridAI contexts', () => {
    expect(
      getProviderContextError({
        provider: 'hybridai',
        baseUrl: 'https://hybridai.one/v1',
        apiKey: 'test-key',
        model: 'gpt-5-nano',
        chatbotId: '',
        toolName: 'vision_analyze',
      }),
    ).toBe('vision_analyze is not configured: missing chatbot_id context.');
  });

  test('preserves active request wording for browser vision errors', () => {
    expect(
      getProviderContextError({
        provider: 'openrouter',
        baseUrl: '',
        apiKey: '',
        model: '',
        chatbotId: '',
        toolName: 'browser_vision',
        missingContextSource: 'active request',
      }),
    ).toBe(
      'browser_vision is not configured: missing active request base URL context.',
    );
  });
});
