import { describe, expect, test } from 'vitest';

import { normalizeToolCalls } from '../container/src/providers/tool-call-normalizer.js';

describe('tool call normalizer', () => {
  test('unwraps nested tool_call wrappers from existing tool calls', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'tool_call',
            arguments:
              '{"name":"tools.shell","arguments":{"command":"ls -la",}}',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'shell',
          arguments: '{"command":"ls -la"}',
        },
      },
    ]);
  });

  test('unwraps tool.call wrappers', () => {
    const result = normalizeToolCalls(
      [
        {
          id: '',
          type: 'function',
          function: {
            name: 'tool.call',
            arguments:
              '{"name":"tool.file_read","arguments":{"path":"README.md"}}',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'file_read',
      arguments: '{"path":"README.md"}',
    });
  });

  test('passes through already-normal tool calls', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"pwd"}',
          },
        },
      ],
      'hello',
    );

    expect(result).toEqual({
      content: 'hello',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"pwd"}',
          },
        },
      ],
    });
  });

  test('extracts XML-style tool calls from content', () => {
    const result = normalizeToolCalls(
      undefined,
      'Before <tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call> After',
    );

    expect(result.content).toBe('Before  After');
    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls"}',
    });
  });

  test('extracts bracketed tool calls in multiple variants', () => {
    const upper = normalizeToolCalls(
      undefined,
      '[TOOL_CALL]{"name":"shell","arguments":{"command":"whoami"}}[/TOOL_CALL]',
    );
    const lower = normalizeToolCalls(
      undefined,
      '[tool_call]{"name":"file_read","arguments":{"path":"package.json"}}[/tool_call]',
    );

    expect(upper.toolCalls[0]?.function.name).toBe('shell');
    expect(lower.toolCalls[0]?.function.name).toBe('file_read');
  });

  test('extracts multiple tool calls from one response', () => {
    const result = normalizeToolCalls(
      undefined,
      [
        'Text',
        '<tool_call>{"name":"shell","arguments":{"command":"pwd"}}</tool_call>',
        '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>',
      ].join('\n'),
    );

    expect(result.toolCalls.map((call) => call.function.arguments)).toEqual([
      '{"command":"pwd"}',
      '{"command":"ls"}',
    ]);
  });

  test('recovers unclosed tool call tags with valid JSON', () => {
    const result = normalizeToolCalls(
      undefined,
      'prefix <tool_call>{"name":"shell","arguments":{"command":"ls",}}',
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls"}',
    });
    expect(result.content).toBe('prefix');
  });

  test('recovers name-prefixed JSON payloads from unclosed tags', () => {
    const result = normalizeToolCalls(
      undefined,
      'text [tool_call]tools.shell{"command":"ls","cwd":"/tmp"}',
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls","cwd":"/tmp"}',
    });
    expect(result.content).toBe('text');
  });

  test('leaves malformed tag JSON untouched', () => {
    const content =
      '<tool_call>{"name":"shell","arguments":not-json}</tool_call>';
    const result = normalizeToolCalls(undefined, content);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('ignores tool call tags inside fenced code blocks', () => {
    const content = [
      '```xml',
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>',
      '```',
    ].join('\n');
    const result = normalizeToolCalls(undefined, content);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('rejects raw JSON without tags for fallback extraction', () => {
    const content = '{"name":"shell","arguments":{"command":"ls"}}';
    const result = normalizeToolCalls(undefined, content);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('treats empty tool_calls arrays as no calls and falls back to content parsing', () => {
    const result = normalizeToolCalls(
      [],
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>',
    );

    expect(result.toolCalls[0]?.function.name).toBe('shell');
  });

  test('normalizes empty arguments to an empty object', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'tool.file_read',
            arguments: '',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'file_read',
      arguments: '{}',
    });
  });
});
