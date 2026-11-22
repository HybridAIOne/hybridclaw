import { expect, test, vi } from 'vitest';
import {
  IncompleteModelResponseError,
  requireCompleteModelResponse,
} from '../container/src/model-response-completion.js';
import {
  modelRetryDelayMs,
  shouldFallbackFromStreamError,
} from '../container/src/model-retry.js';
import { callAuxiliaryModel } from '../container/src/providers/auxiliary.js';
import {
  accumulateApiUsage,
  createTokenUsageStats,
} from '../container/src/token-usage.js';
import type { ChatCompletionResponse } from '../container/src/types.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, restoreAllMocks: true });

test('an unfinished reply exposes only its known usage through the error', () => {
  const response: ChatCompletionResponse = {
    choices: [
      {
        message: { role: 'assistant', content: 'Private unfinished content.' },
        finish_reason: 'incomplete',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
  };
  const error = new IncompleteModelResponseError(response);
  expect(() => requireCompleteModelResponse(response)).toThrow(
    IncompleteModelResponseError,
  );
  expect(JSON.stringify(error)).not.toContain(
    String(response.choices[0].message.content),
  );
  expect(modelRetryDelayMs(1, error)).toBeNull();
  expect(shouldFallbackFromStreamError(error)).toBe(false);
  const usage = createTokenUsageStats();
  accumulateApiUsage(usage, error);
  expect(usage.apiTotalTokens).toBe(125);
  expect(() =>
    requireCompleteModelResponse({
      ...response,
      choices: [{ ...response.choices[0], finish_reason: 'stop' }],
    }),
  ).not.toThrow();
});

test.each(['vision', 'compression'] as const)(
  'unfinished native Ollama output cannot become a successful %s result',
  async (task) => {
    const fetch = vi.fn(async () =>
      Response.json({
        model: 'sample-model',
        done: false,
        message: { role: 'assistant', content: 'Partial neutral analysis.' },
        prompt_eval_count: 100,
        eval_count: 25,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const fallbackContext = {
      provider: 'ollama' as const,
      baseUrl: 'http://127.0.0.1:1234',
      apiKey: 'test-key',
      model: 'sample-model',
      chatbotId: '',
      isLocal: true,
    };
    const promise =
      task === 'vision'
        ? callAuxiliaryModel({
            task,
            fallbackContext,
            question: 'Describe the sample.',
            imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
          })
        : callAuxiliaryModel({
            task,
            fallbackContext,
            messages: [{ role: 'user', content: 'Summarize the sample.' }],
          });
    await expect(promise).rejects.toBeInstanceOf(IncompleteModelResponseError);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
