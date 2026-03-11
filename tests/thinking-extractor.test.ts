import { describe, expect, test } from 'vitest';

import {
  createThinkingDeltaFilter,
  extractThinkingBlocks,
} from '../container/src/providers/thinking-extractor.js';

describe('thinking extractor', () => {
  test('extracts single and multiple think blocks', () => {
    const result = extractThinkingBlocks(
      'Hello<think>plan</think> world <THINK>more</THINK>done',
    );

    expect(result.thinking).toBe('plan\n\nmore');
    expect(result.content).toBe('Hello world done');
    expect(result.thinkingOnly).toBe(false);
  });

  test('leaves plain content unchanged when no think blocks exist', () => {
    expect(extractThinkingBlocks('plain text')).toEqual({
      thinking: null,
      content: 'plain text',
      thinkingOnly: false,
    });
  });

  test('returns fallback content for thinking-only responses', () => {
    const result = extractThinkingBlocks('<think>reasoning only</think>');

    expect(result.thinking).toBe('reasoning only');
    expect(result.content).toBe('Done.');
    expect(result.thinkingOnly).toBe(true);
  });

  test('treats unclosed think tags as thinking until the end', () => {
    const result = extractThinkingBlocks('Answer<think>hidden');

    expect(result.thinking).toBe('hidden');
    expect(result.content).toBe('Answer');
  });

  test('preserves empty think blocks as empty strings', () => {
    const result = extractThinkingBlocks('<think></think>Visible');

    expect(result.thinking).toBe('');
    expect(result.content).toBe('Visible');
  });

  test('ignores think tags inside fenced code blocks', () => {
    const content = ['```html', '<think>ignore me</think>', '```'].join('\n');
    expect(extractThinkingBlocks(content)).toEqual({
      thinking: null,
      content,
      thinkingOnly: false,
    });
  });

  test('null input returns thinking: null, content: null, thinkingOnly: false', () => {
    expect(extractThinkingBlocks(null)).toEqual({
      thinking: null,
      content: null,
      thinkingOnly: false,
    });
  });

  test('suppresses think deltas during streaming', () => {
    const deltas: string[] = [];
    const filter = createThinkingDeltaFilter((delta) => deltas.push(delta));

    filter.push('<think>plan');
    filter.push('</think>Hello');
    filter.push(' world');

    expect(deltas).toEqual(['Hello', ' world']);
    expect(filter.getRawContent()).toBe('<think>plan</think>Hello world');
    expect(filter.getVisibleContent()).toBe('Hello world');
  });
});
