import { describe, expect, test } from 'vitest';

import {
  createThinkingDeltaFilter,
  createThinkingStreamEmitter,
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

  test('drops prefix through orphan closing think tag', () => {
    const result = extractThinkingBlocks('draft answer</think>final answer');

    expect(result.thinking).toBe('draft answer');
    expect(result.content).toBe('final answer');
    expect(result.thinkingOnly).toBe(false);
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

  test('emits raw think tags for transient stream rendering', () => {
    const deltas: string[] = [];
    const emitter = createThinkingStreamEmitter((delta) => deltas.push(delta));

    emitter.pushThinking('plan');
    emitter.pushVisible('Hello');
    emitter.pushVisible(' world');

    expect(deltas).toEqual(['<think>', 'plan', '</think>', 'Hello', ' world']);
    expect(emitter.getRawContent()).toBe('<think>plan</think>Hello world');
    expect(emitter.getVisibleContent()).toBe('Hello world');
  });

  test('can emit thinking inline for providers that stream structured reasoning', () => {
    const deltas: string[] = [];
    const emitter = createThinkingStreamEmitter((delta) => deltas.push(delta), {
      inlineThinking: true,
    });

    emitter.pushThinking('plan');
    emitter.pushVisible('Hello');

    expect(deltas).toEqual(['plan', 'Hello']);
    expect(emitter.getRawContent()).toBe('planHello');
    expect(emitter.getVisibleContent()).toBe('planHello');
  });

  test('can emit structured thinking out of band', () => {
    const deltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const emitter = createThinkingStreamEmitter((delta) => deltas.push(delta), {
      onThinkingDelta: (delta) => thinkingDeltas.push(delta),
    });

    emitter.pushThinking('plan');
    emitter.pushThinking(' more');
    emitter.pushVisible('Hello');

    expect(deltas).toEqual(['Hello']);
    expect(thinkingDeltas).toEqual(['plan', ' more']);
    expect(emitter.getRawContent()).toBe('<think>plan more</think>Hello');
    expect(emitter.getVisibleContent()).toBe('Hello');
  });
});
