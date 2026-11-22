import { expect, test, vi } from 'vitest';
import { validateToolHistory } from '@hybridclaw/shared/tool-history';
import { finalizeParsedToolCalls } from '../container/src/model-response-completion.js';
import { callRoutedModel } from '../container/src/providers/router.js';
import {
  invalidToolCallCorrection,
  rejectedToolExecution,
  validateToolCallBatch,
} from '../container/src/tool-call-validation.js';
import type { ChatMessage, ToolCall } from '../container/src/types.js';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, restoreAllMocks: true });

const call = (id: string, name = 'read'): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: '{"path":"example.txt"}' },
});

test('fills missing IDs once, including identical sibling calls, without mutating proposals', () => {
  const input = {
    content: null,
    toolCalls: [call(''), call('kept-id'), call('')],
  };
  const original = structuredClone(input);
  const complete = finalizeParsedToolCalls(input, 'stop');
  const ids = complete.toolCalls.map((entry) => entry.id);
  expect(ids.every((id) => id.trim().length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(3);
  expect(ids[1]).toBe('kept-id');
  expect(complete.toolCalls.map((entry) => entry.function)).toEqual(
    input.toolCalls.map((entry) => entry.function),
  );
  expect(input).toEqual(original);
  expect(finalizeParsedToolCalls(complete, complete.finishReason)).toEqual(
    complete,
  );
  const history = [
    { role: 'assistant', content: null, tool_calls: complete.toolCalls },
    ...ids.map((id) => ({
      role: 'tool',
      tool_call_id: id,
      content: 'Neutral result.',
    })),
  ];
  expect(() => validateToolHistory(history)).not.toThrow();
});

test.each([
  { reason: 'stop', finish: 'tool_calls', valid: true, correction: true },
  { reason: 'tool_calls', finish: 'tool_calls', valid: true, correction: true },
  { reason: undefined, finish: 'tool_calls', valid: true, correction: true },
  { reason: 'length', finish: 'length', valid: false, correction: true },
  {
    reason: 'content_filter',
    finish: 'content_filter',
    valid: false,
    correction: false,
  },
  { reason: 'unknown', finish: 'unknown', valid: false, correction: false },
])(
  'identity never changes completion authority ($reason)',
  ({ reason, finish, valid, correction }) => {
    const result = finalizeParsedToolCalls(
      { content: null, toolCalls: [call('')] },
      reason,
    );
    expect(result.finishReason).toBe(finish);
    const error = validateToolCallBatch(result.toolCalls, result.finishReason);
    expect(error === null).toBe(valid);
    expect(
      invalidToolCallCorrection('Invalid batch.', result.finishReason) !== null,
    ).toBe(correction);
    expect(result.toolCalls[0].id).not.toBe('');
  },
);

test.each(['length', 'content_filter', undefined])(
  'an ordinary answer needs no call validation (%s)',
  (reason) => {
    expect(validateToolCallBatch([], reason)).toBeNull();
  },
);

test('rejected execution evidence retains its call ID and never claims execution', () => {
  const result = rejectedToolExecution(
    call('rejected'),
    'The batch did not run.',
  );
  expect(result).toMatchObject({
    toolCallId: 'rejected',
    blocked: true,
    isError: true,
    durationMs: 0,
  });
  expect(result.arguments).toBe(call('rejected').function.arguments);
});

test('Ollama history links each result to its contemporary tool name when IDs are reused', async () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [call('same', 'read')] },
    { role: 'tool', tool_call_id: 'same', content: 'Read result.' },
    { role: 'assistant', content: null, tool_calls: [call('same', 'write')] },
    { role: 'tool', tool_call_id: 'same', content: 'Write result.' },
  ];
  const original = structuredClone(messages);
  let received: Array<{ role: string; tool_name?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      received = JSON.parse(String(init?.body)).messages;
      return new Response(
        JSON.stringify({
          model: 'sample-model',
          message: { role: 'assistant', content: 'Finished.' },
          done: true,
          done_reason: 'stop',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  await callRoutedModel({
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:1234',
    apiKey: 'test-key',
    model: 'sample-model',
    chatbotId: '',
    messages,
    tools: [],
  });
  expect(
    received
      .filter((entry) => entry.role === 'tool')
      .map((entry) => entry.tool_name),
  ).toEqual(['read', 'write']);
  expect(messages).toEqual(original);
});
