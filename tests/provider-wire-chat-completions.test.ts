import type { ChatMessage } from '@hybridclaw/contracts/agent-io';
import { normalizeOpenAICompatModelName } from '@hybridclaw/shared/model-names';
import {
  applyChatCompletionsChunk,
  buildChatCompletionsBody,
  collapseSystemMessages,
  createChatCompletionsStreamState,
} from '@hybridclaw/shared/provider-wire/chat-completions';
import { describe, expect, it } from 'vitest';

function reduce(chunks: Array<Record<string, unknown>>) {
  const state = createChatCompletionsStreamState('model-a');
  const added = chunks.map((chunk) => applyChatCompletionsChunk(state, chunk));
  return { state, added };
}

describe('chat-completions model names', () => {
  it.each([
    ['openrouter', 'openrouter/anthropic/claude-sonnet-4', 'anthropic/claude-sonnet-4'],
    ['openrouter', 'openrouter/free', 'openrouter/free'],
    ['huggingface', 'huggingface/org/model', 'org/model'],
    ['vllm', 'VLLM/qwen/qwen3', 'qwen/qwen3'],
    ['mistral', 'mistral-large', 'mistral-large'],
    ['hybridai', 'hybridai/gpt-5-nano', 'hybridai/gpt-5-nano'],
    ['openai-codex', 'openai-codex/gpt-5.4', 'openai-codex/gpt-5.4'],
    [undefined, ' local-model ', 'local-model'],
  ])('%s keeps %s as %s', (provider, model, expected) => {
    expect(normalizeOpenAICompatModelName(provider, model)).toBe(expected);
  });
});

describe('chat-completions request body', () => {
  it.each([
    {
      label: 'without tools or budget',
      params: { tools: [] },
      expected: { model: 'm', messages: [] },
    },
    {
      label: 'with tools and a default choice',
      params: { tools: ['t'] },
      expected: { model: 'm', messages: [], tools: ['t'], tool_choice: 'auto' },
    },
    {
      label: 'with an explicit choice and floored budget',
      params: { tools: ['t'], toolChoice: 'none', maxTokens: 9.9 },
      expected: {
        model: 'm',
        messages: [],
        tools: ['t'],
        tool_choice: 'none',
        max_tokens: 9,
      },
    },
  ])('builds a body $label', ({ params, expected }) => {
    expect(buildChatCompletionsBody({ model: 'm', messages: [], ...params })).toEqual(
      expected,
    );
  });

  it('collapses system messages into one leading message', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'first' },
      { role: 'system', content: [{ type: 'text', text: 'second' }] },
      { role: 'system', content: '  ' },
    ];
    expect(collapseSystemMessages(messages)).toEqual([
      { role: 'system', content: 'first\n\nsecond' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('chat-completions stream reducer', () => {
  it.each([
    {
      label: 'appends content deltas',
      chunks: [
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
      ],
      content: 'Hello',
      added: ['Hel', 'lo'],
    },
    {
      label: 'prefers a message snapshot over its duplicate delta',
      chunks: [
        {
          choices: [
            { message: { content: 'One' }, delta: { content: 'One' } },
          ],
        },
        {
          choices: [
            { message: { content: 'One two' }, delta: { content: ' two' } },
          ],
        },
      ],
      content: 'One two',
      added: ['One', ' two'],
    },
    {
      label: 'replaces content when a snapshot diverges',
      chunks: [
        { choices: [{ delta: { content: 'draft' } }] },
        { choices: [{ message: { content: 'final' } }] },
      ],
      content: 'final',
      added: ['draft', 'final'],
    },
  ])('$label', ({ chunks, content, added }) => {
    const result = reduce(chunks);
    expect(result.state.content).toBe(content);
    expect(result.added.map((entry) => entry.content)).toEqual(added);
  });

  it.each([
    ['reasoning_content', { reasoning_content: 'think' }],
    ['reasoning', { reasoning: 'think' }],
  ])('reads structured reasoning from %s', (_field, delta) => {
    const { state, added } = reduce([{ choices: [{ delta }] }]);
    expect(state.reasoning).toBe('think');
    expect(added[0]?.reasoning).toBe('think');
  });

  it('merges tool-call fragments by index', () => {
    const { state } = reduce([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_', function: { name: 'sh' } },
                { index: 1, id: 'call_b', function: { name: 'read' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: '1', function: { name: 'ell', arguments: '{"a"' } },
                { index: 0, function: { arguments: ':1}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    expect(state.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'shell', arguments: '{"a":1}' },
      },
      {
        id: 'call_b',
        type: 'function',
        function: { name: 'read', arguments: '' },
      },
    ]);
    expect(state.finishReason).toBe('tool_calls');
  });

  it('keeps stream metadata, usage, and a tool-call snapshot', () => {
    const { state } = reduce([
      {
        id: 'resp_1',
        model: 'model-b',
        usage: { prompt_tokens: 3 },
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [{ id: 'call_1', function: { name: 'shell' } }],
              anthropic_content: [{ type: 'text', text: 'x' }],
            },
          },
        ],
      },
    ]);
    expect(state).toMatchObject({
      id: 'resp_1',
      model: 'model-b',
      usage: { prompt_tokens: 3 },
      anthropicContent: [{ type: 'text', text: 'x' }],
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'shell', arguments: '' },
        },
      ],
    });
  });
});
