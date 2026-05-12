import { afterEach, describe, expect, test, vi } from 'vitest';

import { callHybridAIProvider } from '../container/src/providers/hybridai.js';
import type { NormalizedCallArgs } from '../container/src/providers/shared.js';

function makeArgs(
  overrides: Partial<NormalizedCallArgs> = {},
): NormalizedCallArgs {
  return {
    provider: 'hybridai',
    baseUrl: 'https://api.hybridai.test',
    apiKey: 'test-key',
    model: 'gpt-4.1-mini',
    chatbotId: '',
    enableRag: false,
    requestHeaders: undefined,
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: undefined,
    isLocal: false,
    contextWindow: undefined,
    thinkingFormat: undefined,
    ...overrides,
  };
}

describe('provider prompt debug logging', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('does not emit last prompt debug records when model response debug is off', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await callHybridAIProvider(makeArgs({ debugModelResponses: false }));

    expect(stderr).not.toHaveBeenCalledWith(
      expect.stringContaining('[last-prompt-file]'),
    );
  });

  test('emits last prompt debug records when model response debug is on', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: 'chatcmpl_1',
            model: 'gpt-4.1-mini',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }),
    );
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await callHybridAIProvider(makeArgs({ debugModelResponses: true }));

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('[last-prompt-file]'),
    );
  });
});
