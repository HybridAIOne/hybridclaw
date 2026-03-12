import { expect, test } from 'vitest';

import {
  createTuiThinkingStreamState,
  formatTuiStreamDelta,
  indentTuiBlock,
} from '../src/tui-thinking.js';

test('indents the first streamed line and preserves newlines', () => {
  expect(formatTuiStreamDelta('Thinking\nabout\nmusic tastes', true)).toEqual({
    text: '  Thinking\n  about\n  music tastes',
    lineNeedsIndent: false,
  });
});

test('keeps indent state open when a delta ends with a newline', () => {
  expect(formatTuiStreamDelta('hello\n', true)).toEqual({
    text: '  hello\n',
    lineNeedsIndent: true,
  });
});

test('continues an already-open streamed line without re-indenting it', () => {
  expect(formatTuiStreamDelta('world', false)).toEqual({
    text: 'world',
    lineNeedsIndent: false,
  });
});

test('keeps think blocks in the transient preview and streams visible text separately', () => {
  const state = createTuiThinkingStreamState();

  expect(state.push('<think>plan')).toEqual({
    visibleDelta: '',
    thinkingPreview: 'plan',
    sawThinking: true,
  });

  expect(state.push('</think>Hello')).toEqual({
    visibleDelta: 'Hello',
    thinkingPreview: 'plan',
    sawThinking: true,
  });

  expect(state.push(' world')).toEqual({
    visibleDelta: ' world',
    thinkingPreview: 'plan',
    sawThinking: true,
  });
});

test('indents every line in a transient thinking block by two spaces', () => {
  expect(indentTuiBlock('plan\nmore')).toBe('  plan\n  more');
});
