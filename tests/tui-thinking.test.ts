import { expect, test } from 'vitest';

import {
  createTuiStreamFormatState,
  createTuiThinkingStreamState,
  flushTuiStreamDelta,
  formatTuiStreamDelta,
  getTuiStreamTrailingNewlines,
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

test('returns two trailing newlines when streamed output ends mid-line', () => {
  expect(
    getTuiStreamTrailingNewlines({
      ...createTuiStreamFormatState(),
      lineNeedsIndent: false,
      currentLineWidth: 4,
    }),
  ).toBe('\n\n');
});

test('returns one trailing newline when streamed output already ends on a newline', () => {
  expect(getTuiStreamTrailingNewlines(createTuiStreamFormatState())).toBe('\n');
});

test('derives trailing newlines from the post-flush stream state', () => {
  expect(
    getTuiStreamTrailingNewlines(
      {
        ...createTuiStreamFormatState(),
        lineNeedsIndent: false,
        currentLineWidth: 5,
        pendingWhitespace: ' ',
        pendingToken: 'world',
      },
      80,
    ),
  ).toBe('\n\n');
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

test('strips Qwen tool markup from transient thinking previews', () => {
  const state = createTuiThinkingStreamState();
  const result = state.push(
    [
      '<think>#hybridclaw. Let me read from #t.',
      '<tool_call>',
      '<function=message>',
      '<parameter=action>',
      'channel-info',
      '</parameter>',
      '</function>',
      '</tool_call>',
      '</think>',
    ].join('\n'),
  );

  expect(result).toEqual({
    visibleDelta: '',
    thinkingPreview: '#hybridclaw. Let me read from #t.',
    sawThinking: true,
  });
});

test('suppresses unmatched thinking close tails from visible stream text', () => {
  const state = createTuiThinkingStreamState();

  expect(state.push('s.\n</think>\n\nVisible answer')).toEqual({
    visibleDelta: '\nVisible answer',
    thinkingPreview: null,
    sawThinking: false,
  });
});

test('holds split thinking close tails out of the visible stream', () => {
  const state = createTuiThinkingStreamState();

  expect(state.push('<think>plan</think>')).toEqual({
    visibleDelta: '',
    thinkingPreview: 'plan',
    sawThinking: true,
  });
  expect(state.push('s.\n')).toEqual({
    visibleDelta: '',
    thinkingPreview: 'plan',
    sawThinking: true,
  });
  expect(state.push('</think>\n\nVisible answer')).toEqual({
    visibleDelta: '\nVisible answer',
    thinkingPreview: 'plan',
    sawThinking: true,
  });
});

test('gates visible output between split tool tags', () => {
  const state = createTuiThinkingStreamState();

  expect(state.push('Before <too')).toEqual({
    visibleDelta: 'Before ',
    thinkingPreview: null,
    sawThinking: false,
  });
  expect(
    state.push('l_call>{"name":"message","arguments":{"action":"read"}}'),
  ).toEqual({
    visibleDelta: '',
    thinkingPreview: null,
    sawThinking: false,
  });
  expect(state.push('</tool_call> After')).toEqual({
    visibleDelta: ' After',
    thinkingPreview: null,
    sawThinking: false,
  });
});

test('indents every line in a transient thinking block by two spaces', () => {
  expect(indentTuiBlock('plan\nmore')).toBe('  plan\n  more');
});

test('wraps printed tui blocks while preserving the left indent', () => {
  expect(wrapTuiBlock('alpha beta gamma', 10)).toBe('  alpha\n  beta\n  gamma');
});
