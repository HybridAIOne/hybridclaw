import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import { estimateChatMessageTokens } from '@hybridclaw/shared/token-estimate';
import { validateToolHistory } from '@hybridclaw/shared/tool-history';
import { expect, test, vi } from 'vitest';
import {
  callRoutedModel,
  callRoutedModelStream,
} from '../container/src/providers/router.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true });
const model = 'nebius/example/model';
const reasoning = '\n opaque fixture reasoning\n\n';
const tool = {
  id: 'read-note',
  type: 'function' as const,
  function: { name: 'read', arguments: '{"path":"notes.txt"}' },
};
const replay = { provider: 'nebius', model, content: reasoning };
const assistant: ChatMessage = {
  role: 'assistant',
  content: null,
  tool_calls: [tool],
  provider_reasoning: replay,
};
const result: ChatMessage = {
  role: 'tool',
  tool_call_id: tool.id,
  content: 'synthetic note',
};

test.each([false, true])(
  'captures exact tool-call reasoning, streaming=%s',
  async (stream) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        stream
          ? new Response(
              `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', reasoning_content: reasoning, tool_calls: [{ ...tool, index: 0 }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } },
            )
          : Response.json({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: reasoning,
                    tool_calls: [tool],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }),
      ),
    );
    const call = stream ? callRoutedModelStream : callRoutedModel;
    const response = await call({
      provider: 'nebius',
      model,
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      chatbotId: '',
      messages: [],
      tools: [],
      onTextDelta: () => {},
    });
    expect(response.choices[0].message.provider_reasoning).toEqual(replay);
    expect(response.choices[0].message.content).toBeNull();
  },
);

test.each([
  {
    provider: 'nebius' as const,
    selected: model,
    role: 'assistant' as const,
    expected: reasoning,
  },
  {
    provider: 'nebius' as const,
    selected: 'nebius/example/other',
    role: 'assistant' as const,
    expected: undefined,
  },
  {
    provider: 'openrouter' as const,
    selected: model,
    role: 'assistant' as const,
    expected: undefined,
  },
  {
    provider: 'nebius' as const,
    selected: model,
    role: 'user' as const,
    expected: undefined,
  },
])(
  'replay remains bound to the originating assistant/model/provider: %j',
  async ({ provider, selected, role, expected }) => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          choices: [
            {
              message: { role: 'assistant', content: 'Done' },
              finish_reason: 'stop',
            },
          ],
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await callRoutedModel({
      provider,
      model: selected,
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      chatbotId: '',
      messages: [{ ...assistant, role }, result],
      tools: [],
    });
    const body = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body));
    expect(body.messages[0].reasoning_content).toBe(expected);
    expect(body.messages[0]).not.toHaveProperty('provider_reasoning');
  },
);

test('gateway tool-history validation preserves exact bytes and counts their context cost', () => {
  const restored = validateToolHistory(
    JSON.parse(JSON.stringify([assistant, result])),
  );
  expect(restored).toEqual([assistant, result]);
  expect(estimateChatMessageTokens(assistant)).toBeGreaterThan(
    estimateChatMessageTokens({ ...assistant, provider_reasoning: undefined }),
  );
});

test.each(
  [
    null,
    [],
    'opaque',
    { provider: 'nebius', model, content: 1 },
    { provider: 1, model, content: reasoning },
    { provider: 'nebius', content: reasoning },
  ].map((metadata) => ({ metadata })),
)('rejects malformed replay metadata: %j', ({ metadata }) => {
  expect(() =>
    validateToolHistory([
      { ...assistant, provider_reasoning: metadata },
      result,
    ]),
  ).toThrow('Invalid provider reasoning replay metadata.');
});
