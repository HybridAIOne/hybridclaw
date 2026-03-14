import { describe, expect, test } from 'vitest';

import {
  normalizeToolCalls,
  resolveToolCallTextParser,
} from '../container/src/providers/tool-call-normalizer.js';

const hermesOptions = { parser: 'hermes' as const };
const mistralOptions = { parser: 'mistral' as const };
const liquidOptions = { parser: 'liquid' as const };

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
      hermesOptions,
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
      hermesOptions,
    );
    const lower = normalizeToolCalls(
      undefined,
      '[tool_call]{"name":"file_read","arguments":{"path":"package.json"}}[/tool_call]',
      hermesOptions,
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
      hermesOptions,
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
      hermesOptions,
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
      hermesOptions,
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
    const result = normalizeToolCalls(undefined, content, hermesOptions);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('ignores tool call tags inside fenced code blocks', () => {
    const content = [
      '```xml',
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>',
      '```',
    ].join('\n');
    const result = normalizeToolCalls(undefined, content, hermesOptions);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('rejects raw JSON without tags for fallback extraction', () => {
    const content = '{"name":"shell","arguments":{"command":"ls"}}';
    const result = normalizeToolCalls(undefined, content);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('recovers a blank structured tool name from bare content', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: '',
            arguments:
              '{"path":"scripts/create_sales_workbook.cjs","contents":"hi"}',
          },
        },
      ],
      'write',
      { recoverBlankStructuredNameFromContent: true },
    );

    expect(result.content).toBeNull();
    expect(result.toolCalls[0]?.function).toEqual({
      name: 'write',
      arguments: '{"path":"scripts/create_sales_workbook.cjs","contents":"hi"}',
    });
  });

  test('treats empty tool_calls arrays as no calls and falls back to content parsing', () => {
    const result = normalizeToolCalls(
      [],
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>',
      hermesOptions,
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

  test('unwraps tool_call> prefix variant', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'tool_call>123',
            arguments: '{"name":"shell","arguments":{"command":"pwd"}}',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"pwd"}',
    });
  });

  test('unwraps tool_call< prefix variant', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'tool_call<abc',
            arguments: '{"name":"file_read","arguments":{"path":"/tmp/a.txt"}}',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'file_read',
      arguments: '{"path":"/tmp/a.txt"}',
    });
  });

  test('handles tool.call wrapper with nested arguments', () => {
    const result = normalizeToolCalls(
      [
        {
          id: 'call_3',
          type: 'function',
          function: {
            name: 'tool.call',
            arguments:
              '{"name":"tool.shell","arguments":{"command":"echo hi","cwd":"/home"}}',
          },
        },
      ],
      null,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"echo hi","cwd":"/home"}',
    });
  });

  test('JSON repair: unbalanced opening brace adds closing }', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}</tool_call>',
      hermesOptions,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls"}',
    });
  });

  test('JSON repair: strips control characters', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>{"name":"shell","arguments":{"command":"ls\x00\x01"}}</tool_call>',
      hermesOptions,
    );

    expect(result.toolCalls[0]?.function.name).toBe('shell');
    expect(result.toolCalls[0]?.function.arguments).toBe('{"command":"ls"}');
  });

  test('JSON repair: trailing comma inside array', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>{"name":"shell","arguments":{"items":[1,2,]}}</tool_call>',
      hermesOptions,
    );

    expect(result.toolCalls[0]?.function.arguments).toBe('{"items":[1,2]}');
  });

  test('malformed closing tag still extracts via fallback to first close tag', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call_call>rest',
      hermesOptions,
    );

    // The malformed close tag won't match, so the parser treats it as unclosed
    // and extracts the JSON via the unclosed-tag recovery path.
    expect(result.toolCalls.length).toBe(1);
    expect(result.toolCalls[0]?.function.name).toBe('shell');
  });

  test('multiple XML tool calls with interleaved text preserves all text segments', () => {
    const result = normalizeToolCalls(
      undefined,
      'First <tool_call>{"name":"shell","arguments":{"command":"a"}}</tool_call> Middle <tool_call>{"name":"shell","arguments":{"command":"b"}}</tool_call> Last',
      hermesOptions,
    );

    expect(result.toolCalls).toHaveLength(2);
    expect(result.content).toContain('First');
    expect(result.content).toContain('Middle');
    expect(result.content).toContain('Last');
  });

  test('preamble text inside <tool_call> tag before JSON is tolerated', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>I will call shell now {"name":"shell","arguments":{"command":"ls"}}</tool_call>',
      hermesOptions,
    );

    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls"}',
    });
  });

  test('whitespace-only content inside <tool_call> tag yields no tool call', () => {
    const result = normalizeToolCalls(
      undefined,
      '<tool_call>   \n  </tool_call>',
      hermesOptions,
    );

    expect(result.toolCalls).toEqual([]);
  });

  test('handles mix of native tool_calls AND XML in content — native takes priority', () => {
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
      '<tool_call>{"name":"file_read","arguments":{"path":"x"}}</tool_call>',
      hermesOptions,
    );

    // Native tool calls are present, so content is not parsed for XML tool calls
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.function.name).toBe('shell');
    expect(result.content).toContain('<tool_call>');
  });

  test('does not parse tagged tool text without an explicit parser', () => {
    const content =
      '<tool_call>{"name":"shell","arguments":{"command":"ls"}}</tool_call>';
    const result = normalizeToolCalls(undefined, content);

    expect(result.toolCalls).toEqual([]);
    expect(result.content).toBe(content);
  });

  test('extracts mistral [TOOL_CALLS] text with an explicit parser', () => {
    const result = normalizeToolCalls(
      undefined,
      'Working...\n[TOOL_CALLS]write{"path":"scripts/create_excel.cjs","contents":"hi"}',
      mistralOptions,
    );

    expect(result.content).toBe('Working...');
    expect(result.toolCalls[0]?.function).toEqual({
      name: 'write',
      arguments: '{"path":"scripts/create_excel.cjs","contents":"hi"}',
    });
  });

  test('extracts liquid python-style tool calls from content', () => {
    const result = normalizeToolCalls(
      undefined,
      'Thinking... <|tool_call_start|>[tools.shell(command="ls -la", cwd="/tmp")]<|tool_call_end|> Done',
      liquidOptions,
    );

    expect(result.content).toBe('Thinking...  Done');
    expect(result.toolCalls[0]?.function).toEqual({
      name: 'shell',
      arguments: '{"command":"ls -la","cwd":"/tmp"}',
    });
  });

  test('extracts multiple liquid tool calls and preserves non-tool text', () => {
    const result = normalizeToolCalls(
      undefined,
      'Before <|tool_call_start|>[first(value=1), second(flag=true)]<|tool_call_end|> After',
      liquidOptions,
    );

    expect(result.content).toBe('Before  After');
    expect(result.toolCalls.map((call) => call.function)).toEqual([
      { name: 'first', arguments: '{"value":1}' },
      { name: 'second', arguments: '{"flag":true}' },
    ]);
  });

  test('resolves parser names by model family', () => {
    expect(resolveToolCallTextParser('mistralai/devstral')).toBe('mistral');
    expect(resolveToolCallTextParser('Qwen/Qwen3-Coder-30B-A3B')).toBe(
      'qwen3_coder',
    );
    expect(resolveToolCallTextParser('deepseek-ai/DeepSeek-V3.1')).toBe(
      'deepseek_v3_1',
    );
    expect(resolveToolCallTextParser('LiquidAI/LFM2.5-1.2B-Instruct')).toBe(
      'liquid',
    );
    expect(resolveToolCallTextParser('unknown/model')).toBeNull();
  });
});
