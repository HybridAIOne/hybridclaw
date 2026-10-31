import { expect, test, vi } from 'vitest';
import { callAuxiliaryModel } from '../container/src/providers/auxiliary.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ restoreAllMocks: true, unstubAllGlobals: true });

test.each([
  { configured: undefined, expected: 8_192 },
  { configured: 0, expected: 8_192 },
  { configured: Number.NaN, expected: 8_192 },
  { configured: 1_536.9, expected: 1_536 },
  { configured: 12_000, expected: 12_000 },
])(
  'vision reserves a bounded output budget: $configured',
  async ({ configured, expected }) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      if (!body.max_tokens || body.max_tokens > 20_000) {
        return new Response(
          'Insufficient credit for the maximum output reserve',
          { status: 402 },
        );
      }
      expect(body.max_tokens).toBe(expected);
      return Response.json({
        choices: [
          {
            message: { role: 'assistant', content: 'Image analysis.' },
            finish_reason: 'stop',
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await callAuxiliaryModel({
      task: 'vision',
      fallbackContext: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'test-key',
        model: 'openrouter/example/vision-model',
        chatbotId: '',
        maxTokens: configured,
      },
      question: 'Describe the image.',
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    });
    expect(result.analysis).toBe('Image analysis.');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test('does not present a token-limited partial vision response as a complete analysis', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Only the beginning of the document.',
            },
            finish_reason: 'length',
          },
        ],
      }),
    ),
  );
  await expect(
    callAuxiliaryModel({
      task: 'vision',
      fallbackContext: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'test-key',
        model: 'openrouter/example/vision-model',
        chatbotId: '',
      },
      question: 'Transcribe the document.',
      imageDataUrl: 'data:image/png;base64,ZmFrZQ==',
    }),
  ).rejects.toThrow('analysis is incomplete');
});
