import { expect, test, vi } from 'vitest';
import {
  callRoutedModel,
  callRoutedModelStream,
} from '../container/src/providers/router.js';
import type { ChatMessage } from '../container/src/types.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, restoreAllMocks: true });

const proposed = {
  id: 'example',
  type: 'function' as const,
  function: {
    name: 'write',
    arguments: '{"path":"example.txt","contents":"Neutral sample."}',
  },
};
const markup = `<tool_call>${JSON.stringify({ name: proposed.function.name, arguments: JSON.parse(proposed.function.arguments) })}</tool_call>`;
const reasoning = `A hypothetical call would be ${markup}.`;
const answer = 'The existing result is sufficient.';

async function respond(
  stream: boolean,
  inline: boolean,
  final: string | null,
  calls?: (typeof proposed)[],
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const message = inline
        ? {
            role: 'assistant',
            content: `<think>${reasoning}</think>${final ?? ''}`,
            ...(calls ? { tool_calls: calls } : {}),
          }
        : {
            role: 'assistant',
            reasoning_content: reasoning,
            content: final,
            ...(calls ? { tool_calls: calls } : {}),
          };
      const finish = calls?.length ? 'tool_calls' : 'stop';
      if (!stream)
        return new Response(
          JSON.stringify({ choices: [{ message, finish_reason: finish }] }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      const delta = inline
        ? { content: message.content }
        : {
            reasoning_content: reasoning,
            ...(final === null ? {} : { content: final }),
          };
      const chunks = [
        { choices: [{ delta }] },
        ...(calls
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: calls.map((call, index) => ({
                        ...call,
                        index,
                      })),
                    },
                  },
                ],
              },
            ]
          : []),
        { choices: [{ delta: {}, finish_reason: finish }] },
      ];
      return new Response(
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
          'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }),
  );
  const params = {
    provider: 'vllm' as const,
    baseUrl: 'http://127.0.0.1:1234/v1',
    apiKey: 'test-key',
    model: 'sample-model',
    chatbotId: '',
    isLocal: true,
    modelBehavior: { thinkingFormat: 'qwen' as const },
    thinkingFormat: 'qwen' as const,
    messages: [
      { role: 'user', content: 'Summarize the available result.' },
    ] as ChatMessage[],
    tools: [
      {
        type: 'function' as const,
        function: {
          name: 'write',
          description: 'Write a neutral fixture.',
          parameters: { type: 'object' },
        },
      },
    ],
  };
  return stream
    ? callRoutedModelStream({ ...params, onTextDelta: () => {} })
    : callRoutedModel(params);
}

const variants = [
  { stream: false, inline: false },
  { stream: false, inline: true },
  { stream: true, inline: false },
  { stream: true, inline: true },
];

test.each(variants)(
  'a final answer never promotes a proposed call from reasoning ($stream/$inline)',
  async ({ stream, inline }) => {
    const result = await respond(stream, inline, answer);
    expect(result.choices[0].message.content).toBe(answer);
    expect(result.choices[0].message.tool_calls ?? []).toEqual([]);
    expect(result.choices[0].finish_reason).toBe('stop');
  },
);

test.each(variants)(
  'retains existing reasoning-only call recovery ($stream/$inline)',
  async ({ stream, inline }) => {
    const result = await respond(stream, inline, null);
    expect(
      result.choices[0].message.tool_calls?.map((call) => call.function),
    ).toEqual([proposed.function]);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  },
);

test.each(variants)(
  'explicit structured calls remain authoritative ($stream/$inline)',
  async ({ stream, inline }) => {
    const actual = {
      ...proposed,
      function: {
        ...proposed.function,
        arguments: '{"path":"actual.txt","contents":"Requested sample."}',
      },
    };
    const result = await respond(stream, inline, answer, [actual]);
    expect(result.choices[0].message.tool_calls).toEqual([actual]);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  },
);

test.each(variants)(
  'formal calls in the final response still work ($stream/$inline)',
  async ({ stream, inline }) => {
    const result = await respond(stream, inline, markup);
    expect(
      result.choices[0].message.tool_calls?.map((call) => call.function),
    ).toEqual([proposed.function]);
    expect(result.choices[0].finish_reason).toBe('tool_calls');
  },
);
