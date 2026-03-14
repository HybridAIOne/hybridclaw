import { expect, test } from 'vitest';

import {
  createTuiStreamFormatState,
  createTuiThinkingStreamState,
  flushTuiStreamDelta,
  formatTuiStreamDelta,
  indentTuiBlock,
  wrapTuiBlock,
} from '../src/tui-thinking.js';

function formatCompleteStreamDelta(delta: string, columns = 0) {
  const streamed = formatTuiStreamDelta(
    delta,
    createTuiStreamFormatState(),
    columns,
  );
  const flushed = flushTuiStreamDelta(streamed.state, columns);
  return {
    text: `${streamed.text}${flushed.text}`,
    state: flushed.state,
  };
}

test('indents the first streamed line and preserves newlines', () => {
  expect(formatCompleteStreamDelta('Thinking\nabout\nmusic tastes')).toEqual({
    text: '  Thinking\n  about\n  music tastes',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 12,
      pendingWhitespace: '',
      pendingToken: '',
    },
  });
});

test('keeps indent state open when a delta ends with a newline', () => {
  expect(formatTuiStreamDelta('hello\n', createTuiStreamFormatState())).toEqual(
    {
      text: '  hello\n',
      state: {
        lineNeedsIndent: true,
        currentLineWidth: 0,
        pendingWhitespace: '',
        pendingToken: '',
      },
    },
  );
});

test('continues an already-open streamed line without re-indenting it', () => {
  const state = {
    lineNeedsIndent: false,
    currentLineWidth: 5,
    pendingWhitespace: '',
    pendingToken: '',
  };
  expect(formatTuiStreamDelta('world ', state)).toEqual({
    text: 'world',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 10,
      pendingWhitespace: ' ',
      pendingToken: '',
    },
  });
});

test('flushes an already-open streamed line without re-indenting it', () => {
  expect(
    flushTuiStreamDelta({
      lineNeedsIndent: false,
      currentLineWidth: 5,
      pendingWhitespace: ' ',
      pendingToken: 'world',
    }),
  ).toEqual({
    text: ' world',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 11,
      pendingWhitespace: '',
      pendingToken: '',
    },
  });
});

test('soft-wraps streamed content before terminal hard-wrap would break indent', () => {
  expect(formatCompleteStreamDelta('abcdef', 6)).toEqual({
    text: '  abcd\n  ef',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 2,
      pendingWhitespace: '',
      pendingToken: '',
    },
  });
});

test('drops the wrap-triggering prose space when streaming onto a new visual line', () => {
  expect(formatCompleteStreamDelta('alpha beta', 8)).toEqual({
    text: '  alpha\n  beta',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 4,
      pendingWhitespace: '',
      pendingToken: '',
    },
  });
});

test('keeps punctuation attached to the prior word when the next token would overflow', () => {
  const initial = formatTuiStreamDelta(
    'a helpful and friendly assistant',
    createTuiStreamFormatState(),
    26,
  );
  const next = formatTuiStreamDelta('. Feel free to ask', initial.state, 26);
  const flushed = flushTuiStreamDelta(next.state, 26);

  expect(`${initial.text}${next.text}${flushed.text}`).toBe(
    '  a helpful and friendly\n  assistant. Feel free to\n  ask',
  );
});

test('buffers an incomplete trailing token until the stream finishes', () => {
  const streamed = formatTuiStreamDelta(
    'hello wor',
    createTuiStreamFormatState(),
  );
  expect(streamed).toEqual({
    text: '  hello',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 5,
      pendingWhitespace: ' ',
      pendingToken: 'wor',
    },
  });
  expect(flushTuiStreamDelta(streamed.state)).toEqual({
    text: ' wor',
    state: {
      lineNeedsIndent: false,
      currentLineWidth: 9,
      pendingWhitespace: '',
      pendingToken: '',
    },
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

test('wraps printed tui blocks while preserving the left indent', () => {
  expect(wrapTuiBlock('alpha beta gamma', 10)).toBe('  alpha\n  beta\n  gamma');
});
