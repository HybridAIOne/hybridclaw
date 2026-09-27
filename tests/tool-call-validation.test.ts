import { describe, expect, test } from 'vitest';

import {
  invalidToolCallCorrection,
  validateStructuredToolCalls,
  withReplaySafeArguments,
} from '../container/src/tool-call-validation.js';
import type { ToolCall } from '../container/src/types.js';

describe('structured tool call validation', () => {
  test('rejects malformed structured tool call arguments', () => {
    const error = validateStructuredToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'write',
          arguments:
            '{"path":"/app/ars.R","contents":"line 1\\nline 2\\npartial',
        },
      },
    ]);

    expect(error).toContain('Model emitted malformed tool arguments');
    expect(error).toContain('`write`');
    expect(error).toContain('Unterminated string');
  });

  test('rejects non-object structured tool call arguments', () => {
    const error = validateStructuredToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'bash',
          arguments: '"pip install pandas"',
        },
      },
    ]);

    expect(error).toBe(
      'Model emitted invalid tool arguments for `bash`: expected a JSON object.',
    );
  });

  test('accepts valid structured tool call arguments', () => {
    const error = validateStructuredToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'write',
          arguments: '{"path":"/app/ars.R","contents":"ok"}',
        },
      },
    ]);

    expect(error).toBeNull();
  });
});

describe('rejected tool call batches', () => {
  const call = (id: string, args: string): ToolCall => ({
    id,
    type: 'function',
    function: { name: 'write', arguments: args },
  });

  test('the correction carries the validation error for the model', () => {
    const error = 'Model emitted malformed tool arguments for `write`: x.';

    const correction = invalidToolCallCorrection(error, 'tool_calls');
    const cutOff = invalidToolCallCorrection(error, 'length');

    expect(correction).toContain(error);
    expect(cutOff).toContain(error);
    expect(cutOff.length).toBeGreaterThan(correction.length);
  });

  test('replayed calls keep their ids and only well-formed arguments', () => {
    const valid = call('call_ok', '{"path":"a.txt","contents":"ok"}');
    const calls = [
      valid,
      call('call_cut', '{"path":"b.txt","contents":"partial'),
      call('call_text', '"pip install pandas"'),
      call('call_empty', ''),
    ];

    const replayed = withReplaySafeArguments(calls);

    expect(replayed[0]).toBe(valid);
    expect(replayed.map((entry) => entry.id)).toEqual(
      calls.map((entry) => entry.id),
    );
    expect(replayed.slice(1).map((entry) => entry.function.arguments)).toEqual(
      ['{}', '{}', '{}'],
    );
    expect(calls[1].function.arguments).toContain('partial');
  });
});
