import { REASONING_EFFORTS } from '@hybridclaw/contracts/reasoning-effort';
import { expect, test, vi } from 'vitest';
import {
  callRoutedModel,
  callRoutedModelStream,
} from '../container/src/providers/router.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true });

const cases = (['nebius', 'openrouter'] as const).flatMap((provider) =>
  [false, true].flatMap((stream) =>
    [undefined, ...REASONING_EFFORTS].map((effort) => ({
      provider,
      stream,
      effort,
    })),
  ),
);

test.each(cases)(
  'routes provider reasoning to the wire: %j',
  async ({ provider, stream, effort }) => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        stream
          ? new Response(
              'data: {"choices":[{"delta":{"content":"READY"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
              {
                headers: { 'Content-Type': 'text/event-stream' },
              },
            )
          : Response.json({
              choices: [
                {
                  message: { role: 'assistant', content: 'READY' },
                  finish_reason: 'stop',
                },
              ],
            }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const call = stream ? callRoutedModelStream : callRoutedModel;
    const response = await call({
      provider,
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: `${provider}/example/model`,
      chatbotId: '',
      messages: [{ role: 'user', content: 'Return READY.' }],
      tools: [],
      maxTokens: 128,
      reasoningEffort: effort,
      onTextDelta: () => {},
    });
    expect(response.choices[0]?.message.content).toBe('READY');
    const body = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body));
    expect(body.max_tokens).toBe(128);
    expect(body.chat_template_kwargs).toBeUndefined();
    expect(body.reasoning_effort).toBe(
      provider === 'nebius' ? effort : undefined,
    );
    expect(body.reasoning).toEqual(
      provider === 'openrouter' && effort !== undefined
        ? { enabled: effort !== 'none', effort }
        : undefined,
    );
  },
);
