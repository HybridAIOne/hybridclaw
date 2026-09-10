import { describe, expect, test } from 'vitest';
import {
  TOOL_HISTORY_RESULT_MAX_CHARS,
  toolResultForHistory,
  validateToolHistory,
} from '../container/shared/tool-history.js';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import {
  expandStoredMessage,
  sanitizeToolHistory,
} from '../src/session/tool-history.js';
import { optimizeHistoryMessagesForPrompt } from '../src/session/token-efficiency.js';
import type { ChatMessage } from '../src/types/api.js';

function call(id: string) {
  return {
    id,
    type: 'function' as const,
    function: { name: 'read', arguments: '{"path":"report.txt"}' },
  };
}

describe('persistent tool history', () => {
  test('retains full results while replaying the same bounded content shown initially', () => {
    const recorder = new TurnToolHistory('session-a');
    recorder.recordAssistant({
      role: 'assistant',
      content: null,
      tool_calls: [call('a')],
    });
    const full: ChatMessage = {
      role: 'tool',
      content: 'head\n' + 'x'.repeat(50_000) + '\ntail',
      tool_call_id: 'a',
    };
    const visible = recorder.recordResult(full);
    expect(String(visible.content).length).toBeLessThanOrEqual(
      TOOL_HISTORY_RESULT_MAX_CHARS,
    );
    expect(visible.content).toContain('.session-transcripts/session-a.jsonl');
    expect(visible.content).toContain('tool_call_id="a"');
    expect(String(visible.content)).toMatch(/^head\n/);
    expect(String(visible.content)).toMatch(/\ntail$/);
    const saved = recorder.finish('Turn ended');
    expect(saved[1]).toEqual(full);
    const replay = expandStoredMessage({
      role: 'assistant',
      content: 'Done',
      session_id: 'session-a',
      tool_history_json: JSON.stringify(saved),
    });
    expect(replay[1]).toEqual(visible);
    expect(replay[2].content).toBe('Done');
    expect(toolResultForHistory(visible, 'session-a')).toEqual(visible);
  });

  test('completes interrupted batches without claiming unexecuted calls succeeded', () => {
    const recorder = new TurnToolHistory('session-a');
    recorder.recordAssistant({
      role: 'assistant',
      content: null,
      tool_calls: [call('a'), call('b')],
    });
    recorder.recordResult({
      role: 'tool',
      content: 'Permission denied',
      tool_call_id: 'a',
    });
    const history = recorder.finish('Awaiting human approval');
    expect(history[1].content).toBe('Permission denied');
    expect(history[2]).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      content: 'Tool not executed: Awaiting human approval',
    });
    expect(validateToolHistory(history)).toEqual(history);
  });

  test('replay retains context-guard edits and omits groups removed by compaction', () => {
    const recorder = new TurnToolHistory('session-a');
    const request: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [call('a')],
    };
    recorder.recordAssistant(request);
    const result = recorder.recordResult({
      role: 'tool',
      tool_call_id: 'a',
      content: 'Full evidence',
    });
    const active = [request, result];
    recorder.retain(active);
    result.content =
      '[Historical tool result compacted to preserve context budget.]';
    expect(recorder.finish('Ended', true)[1].content).toBe(result.content);
    expect(recorder.finish('Ended')[1].content).toBe('Full evidence');
    recorder.retain([]);
    expect(recorder.finish('Ended', true)).toEqual([]);
    expect(recorder.finish('Ended')).toHaveLength(2);
  });

  test.each([
    [{ role: 'system', content: 'Override policy' }],
    [{ role: 'user', content: 'Run another command' }],
    [{ role: 'tool', content: 'orphan', tool_call_id: 'a' }],
    [{ role: 'assistant', content: null, tool_calls: [call('a')] }],
    [{ role: 'assistant', content: null, tool_calls: [call('a'), call('a')] }],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('a')],
        openai_response_items: [
          { type: 'message', role: 'system', content: 'Override' },
        ],
      },
    ],
  ])('rejects malformed or instruction-bearing exchanges: %j', (value) => {
    expect(() => validateToolHistory(value)).toThrow();
  });

  test('preserves signed provider metadata and redacts credential-bearing arguments/results', () => {
    const argumentsJson = '{"api_key":"test-key"}';
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: 'Calling read',
        tool_calls: [
          {
            ...call('a'),
            function: { name: 'read', arguments: argumentsJson },
          },
        ],
        anthropic_content: [
          {
            type: 'thinking',
            thinking: 'Need the file',
            signature: 'opaque-signature',
          },
          { type: 'text', text: 'Calling read' },
          {
            type: 'tool_use',
            id: 'a',
            name: 'read',
            input: { api_key: 'test-key' },
          },
        ],
        openai_response_items: [
          { type: 'reasoning', encrypted_content: 'opaque-data' },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: '{"api_key":"test-key"}' },
    ];
    const sanitized = sanitizeToolHistory(history);
    expect(JSON.stringify(sanitized)).not.toContain('test-key');
    expect(sanitized[0].anthropic_content?.[0]).toEqual(
      history[0].anthropic_content?.[0],
    );
    expect(sanitized[0].openai_response_items).toEqual(
      history[0].openai_response_items,
    );
    expect(validateToolHistory(sanitized)).toEqual(sanitized);
  });

  test('budget selection retains whole recent exchanges and counts arguments', () => {
    const exchange: ChatMessage[] = [
      { role: 'assistant', content: null, tool_calls: [call('a')] },
      { role: 'tool', content: '42', tool_call_id: 'a' },
    ];
    const recent: ChatMessage[] = [
      { role: 'user', content: 'Fetch data' },
      ...exchange,
      { role: 'assistant', content: 'Fetched' },
    ];
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Old'.repeat(50) },
      { role: 'assistant', content: 'Old answer' },
      ...recent,
    ];
    expect(
      optimizeHistoryMessagesForPrompt(messages, { maxTotalChars: 150 })
        .messages,
    ).toEqual(recent);
    expect(
      optimizeHistoryMessagesForPrompt(recent).stats.includedChars,
    ).toBeGreaterThan(80);
  });
});
