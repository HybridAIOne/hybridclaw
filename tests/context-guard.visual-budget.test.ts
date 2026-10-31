import { afterEach, expect, test, vi } from 'vitest';
import { applyContextGuard } from '../container/src/context-guard.js';
import { compactInLoop } from '../container/src/in-loop-compaction.js';
import {
  callWithVisualContent,
  estimateVisualMessageTokens,
  setVisualMediaAllowed,
} from '../container/src/providers/visual-content.js';
import { createTokenEstimateCache } from '../container/src/token-usage.js';
import type { ChatMessage } from '../container/src/types.js';

afterEach(() => setVisualMediaAllowed(false));

test('rejects a summary that only appears smaller because of unsent pixels', async () => {
  setVisualMediaAllowed(true, false);
  const messages: ChatMessage[] = history().flatMap((message) =>
    message.role === 'tool'
      ? [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: message.tool_call_id as string,
                type: 'function',
                function: { name: 'read', arguments: '{}' },
              },
            ],
          },
          { ...message, content: 'Extracted text.' },
        ]
      : [message],
  );
  const write = vi.fn();
  const result = await compactInLoop({
    history: messages,
    archive: { path: 'archive.json', write },
    estimateTokens: (input) => estimateVisualMessageTokens(input),
    summarize: async () => ({
      choices: [
        {
          message: { role: 'assistant', content: 'longer '.repeat(5_000) },
          finish_reason: 'stop',
        },
      ],
    }),
  });
  expect(result.history).toBe(messages);
  expect(result.changed).toBe(false);
  expect(write).not.toHaveBeenCalled();
});

function history(): ChatMessage[] {
  return [
    { role: 'system', content: 'Instructions '.repeat(1_000) },
    ...Array.from(
      { length: 32 },
      (_, index): ChatMessage => ({
        role: 'tool',
        tool_call_id: `read-${index}`,
        content: `Document ${index}: ${'Complete extracted evidence. '.repeat(40)}`,
        visualAttachments: [
          { id: index.toString(16).padStart(64, '0'), pages: [1] },
        ],
      }),
    ),
  ];
}

test.each([
  { allowed: true, supports: false },
  { allowed: false, supports: true },
])(
  'counts text handoffs instead of unsent pixels: %j',
  ({ allowed, supports }) => {
    setVisualMediaAllowed(allowed, supports);
    const messages = history();
    const before = structuredClone(messages);
    const result = applyContextGuard({
      history: messages,
      contextWindowTokens: 128_000,
    });
    expect(result.tier3Triggered).toBe(false);
    expect(result.totalTokensAfter).toBeLessThan(30_000);
    expect(messages).toEqual(before);
  },
);

test('re-evaluates visual routing without corrupting cached message estimates', () => {
  const messages = history();
  const cache = createTokenEstimateCache();
  setVisualMediaAllowed(true, true);
  expect(
    applyContextGuard({
      history: messages,
      contextWindowTokens: 128_000,
      cache,
    }).tier3Triggered,
  ).toBe(true);
  setVisualMediaAllowed(true, false);
  expect(
    applyContextGuard({
      history: messages,
      contextWindowTokens: 128_000,
      cache,
    }).tier3Triggered,
  ).toBe(false);
  setVisualMediaAllowed(true, true);
  expect(
    applyContextGuard({
      history: messages,
      contextWindowTokens: 128_000,
      cache,
    }).tier3Triggered,
  ).toBe(true);
});

test('uses text estimates for a CLI route even when the primary model supports images', () => {
  setVisualMediaAllowed(true, true);
  expect(
    applyContextGuard({
      history: history(),
      contextWindowTokens: 128_000,
      providerMethod: 'claude-cli',
    }).tier3Triggered,
  ).toBe(false);
});

test('keeps every durable visual reference in a compact batched handoff', async () => {
  setVisualMediaAllowed(true, false);
  const messages = history().slice(1, 9);
  await callWithVisualContent(
    {
      provider: 'openrouter',
      model: 'example-text',
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      chatbotId: '',
      enableRag: false,
      messages,
      requestHeaders: undefined,
      maxTokens: undefined,
      isLocal: false,
      contextWindow: undefined,
      thinkingFormat: undefined,
      tools: [
        {
          type: 'function',
          function: {
            name: 'vision_analyze',
            description: 'Analyze a snapshot',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    },
    async (request) => {
      expect(
        request.messages.slice(0, 8).map(({ content }) => content),
      ).toEqual(messages.map(({ content }) => content));
      const handoff = JSON.stringify(request.messages.at(-1)?.content);
      expect(handoff.length).toBeLessThan(2_500);
      expect(handoff).toContain('vision_analyze');
      expect(handoff).not.toContain('base64');
      for (const message of messages) {
        expect(handoff).toContain(message.tool_call_id);
        expect(handoff).toContain(message.visualAttachments?.[0].id);
      }
      return {
        choices: [
          {
            message: { role: 'assistant', content: 'done' },
            finish_reason: 'stop',
          },
        ],
      };
    },
  );
});
