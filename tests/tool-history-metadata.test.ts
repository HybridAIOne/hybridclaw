import { describe, expect, test } from 'vitest';
import { TurnToolHistory } from '../container/src/turn-tool-history.js';
import { validateToolHistory } from '#shared/tool-history.js';

function history(input: unknown, id = 'call-a', name = 'lookup') {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-a',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: JSON.stringify({
              query: 'sample',
              options: { limit: 3, sort: 'date' },
              tags: ['first', 'second'],
            }),
          },
        },
      ],
      anthropic_content: [
        {
          type: 'thinking',
          thinking: 'Look it up.',
          signature: 'test-signature',
        },
        { type: 'tool_use', id, name, input },
      ],
    },
    { role: 'tool', tool_call_id: 'call-a', content: 'done' },
  ];
}

const input = {
  tags: ['first', 'second'],
  options: { sort: 'date', limit: 3 },
  query: 'sample',
};

describe('Anthropic tool history metadata', () => {
  test('accepts reordered object keys without rewriting signed metadata', () => {
    const messages = history(input);
    expect(validateToolHistory(messages)).toEqual(messages);
  });

  test('a completed turn saves semantically identical provider arguments', () => {
    const messages = history(input);
    const collector = new TurnToolHistory('test-session');
    collector.recordAssistant(messages[0]);
    collector.recordResult(messages[1]);
    expect(collector.finish('completed')).toEqual(messages);
  });

  test.each([
    ['changed value', { ...input, query: 'other' }],
    ['changed nested value', { ...input, options: { sort: 'date', limit: 4 } }],
    ['changed type', { ...input, options: { sort: 'date', limit: '3' } }],
    ['changed array order', { ...input, tags: ['second', 'first'] }],
    ['missing key', { tags: input.tags, options: input.options }],
    ['extra key', { ...input, extra: true }],
  ])('rejects %s', (_label, changed) => {
    expect(() => validateToolHistory(history(changed))).toThrow(
      'Historical Anthropic tool metadata does not match its calls.',
    );
  });

  test.each([
    ['call-b', 'lookup'],
    ['call-a', 'other'],
  ])('rejects mismatched id/name: %s/%s', (id, name) => {
    expect(() => validateToolHistory(history(input, id, name))).toThrow(
      'Historical Anthropic tool metadata does not match its calls.',
    );
  });

  test('rejects duplicate provider tool blocks', () => {
    const messages = history(input);
    const blocks = messages[0].anthropic_content;
    if (!blocks) throw new Error('Fixture is missing provider metadata.');
    blocks.push(blocks[1]);
    expect(() => validateToolHistory(messages)).toThrow(
      'Historical Anthropic tool metadata does not match its calls.',
    );
  });
});
