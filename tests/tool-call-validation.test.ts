import { describe, expect, test } from 'vitest';

import { validateStructuredToolCalls } from '../container/src/tool-call-validation.js';

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
