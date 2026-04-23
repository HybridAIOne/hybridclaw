const DEFAULT_TUI_INDENT = '  ';
const STREAM_TOKEN_PATTERN = /(\n|[^\S\n]+|\S+)/g;

export interface TuiStreamFormatState {
  lineNeedsIndent: boolean;
  currentLineWidth: number;
  pendingWhitespace: string;
  pendingToken: string;
}

export function createTuiStreamFormatState(): TuiStreamFormatState {
  return {
    lineNeedsIndent: true,
    currentLineWidth: 0,
    pendingWhitespace: '',
    pendingToken: '',
  };
}

export function formatTuiStreamDelta(
  delta: string,
  state: TuiStreamFormatState,
  columns = 0,
  indent = DEFAULT_TUI_INDENT,
): { text: string; state: TuiStreamFormatState } {
  const normalizedDelta = String(delta || '');
  if (!normalizedDelta) {
    return {
      text: '',
      state: { ...state },
    };
  }

  const nextState = { ...state };
  const normalized = normalizedDelta.replace(/\r\n?/g, '\n');
  const tokens = tokenizeCompleteStreamTokens(
    `${nextState.pendingToken}${normalized}`,
  );
  nextState.pendingToken = tokens.trailingToken;
  let text = '';

  const emitIndent = () => {
    if (!nextState.lineNeedsIndent) return;
    text += indent;
    nextState.lineNeedsIndent = false;
  };

  const emitNewline = () => {
    text += '\n';
    nextState.lineNeedsIndent = true;
    nextState.currentLineWidth = 0;
  };

  const emitChunk = (chunk: string) => {
    for (const char of chunk) {
      if (char === '\n') {
        emitNewline();
        continue;
      }
      emitIndent();
      text += char;
      nextState.currentLineWidth += 1;
    }
  };

  const contentWidth =
    columns > 0 ? Math.max(1, Math.floor(columns) - indent.length) : 0;

  const emitToken = (token: string) => {
    let leadingWhitespace = nextState.pendingWhitespace;
    nextState.pendingWhitespace = '';
    if (!token) return;

    if (
      contentWidth > 0 &&
      nextState.currentLineWidth > 0 &&
      nextState.currentLineWidth + leadingWhitespace.length + token.length >
        contentWidth
    ) {
      emitNewline();
      leadingWhitespace = normalizeWrappedWhitespace(leadingWhitespace);
    }

    if (leadingWhitespace) {
      emitChunk(leadingWhitespace);
    }

    let remaining = token;
    while (remaining) {
      if (contentWidth > 0 && nextState.currentLineWidth >= contentWidth) {
        emitNewline();
      }
      emitIndent();
      const available =
        contentWidth > 0
          ? Math.max(1, contentWidth - nextState.currentLineWidth)
          : remaining.length;
      const segment =
        contentWidth > 0 ? remaining.slice(0, available) : remaining;
      emitChunk(segment);
      remaining = remaining.slice(segment.length);
      if (remaining) {
        emitNewline();
      }
    }
  };

  for (const token of tokens.tokens) {
    if (token === '\n') {
      nextState.pendingWhitespace = '';
      emitNewline();
      continue;
    }
    if (/^[^\S\n]+$/u.test(token)) {
      nextState.pendingWhitespace += token;
      continue;
    }
    emitToken(token);
  }

  return {
    text,
    state: nextState,
  };
}

export function flushTuiStreamDelta(
  state: TuiStreamFormatState,
  columns = 0,
  indent = DEFAULT_TUI_INDENT,
): { text: string; state: TuiStreamFormatState } {
  if (!state.pendingToken) {
    return {
      text: '',
      state: { ...state, pendingWhitespace: '' },
    };
  }

  const flushed = formatTuiStreamDelta(
    `${state.pendingToken} `,
    {
      ...state,
      pendingToken: '',
    },
    columns,
    indent,
  );
  return {
    text: flushed.text.trimEnd(),
    state: {
      ...flushed.state,
      pendingWhitespace: '',
      pendingToken: '',
    },
  };
}

export function getTuiStreamTrailingNewlines(
  state: TuiStreamFormatState,
  columns = 0,
  indent = DEFAULT_TUI_INDENT,
): string {
  const flushed = flushTuiStreamDelta(state, columns, indent);
  return flushed.state.lineNeedsIndent ? '\n' : '\n\n';
}

function normalizeWrappedWhitespace(whitespace: string): string {
  if (whitespace === ' ') return '';
  return whitespace;
}

function tokenizeCompleteStreamTokens(source: string): {
  tokens: string[];
  trailingToken: string;
} {
  const tokens: string[] = [];
  let trailingToken = '';
  STREAM_TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null = STREAM_TOKEN_PATTERN.exec(source);
  while (match) {
    tokens.push(match[0]);
    match = STREAM_TOKEN_PATTERN.exec(source);
  }

  const lastToken = tokens.at(-1) || '';
  if (lastToken && /^\S+$/u.test(lastToken) && source.endsWith(lastToken)) {
    trailingToken = lastToken;
    tokens.pop();
  }

  return { tokens, trailingToken };
}

export function countTerminalRows(text: string, columns: number): number {
  return Math.max(1, wrapTuiLines(text, columns).length);
}

export function appendTerminalRowCount(
  currentRows: number,
  appendedText: string,
): number {
  const normalized = String(appendedText || '');
  if (!normalized) return currentRows;
  let newlineCount = 0;
  for (const char of normalized) {
    if (char === '\n') newlineCount += 1;
  }
  return currentRows > 0 ? currentRows + newlineCount : newlineCount + 1;
}

export function wrapTuiBlock(
  text: string,
  columns: number,
  indent = DEFAULT_TUI_INDENT,
): string {
  return wrapTuiLines(text, columns, indent).join('\n');
}

export function indentTuiBlock(text: string, indent = '  '): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

export function createTuiThinkingStreamState(): {
  push: (delta: string) => {
    visibleDelta: string;
    thinkingPreview: string | null;
    sawThinking: boolean;
  };
} {
  let rawContent = '';
  let emittedVisibleContent = '';
  let sawThinking = false;

  return {
    push(delta: string) {
      rawContent += String(delta || '');
      const extracted = extractThinkingBlocks(rawContent);
      if (extracted.thinking !== null) sawThinking = true;
      const nextVisible = extracted.thinkingOnly ? '' : extracted.content || '';
      const visibleDelta = nextVisible.startsWith(emittedVisibleContent)
        ? nextVisible.slice(emittedVisibleContent.length)
        : nextVisible;
      emittedVisibleContent = nextVisible;
      return {
        visibleDelta,
        thinkingPreview: formatThinkingPreview(extracted.thinking),
        sawThinking,
      };
    },
  };
}

interface ThinkingExtractionResult {
  thinking: string | null;
  content: string | null;
  thinkingOnly: boolean;
}

function findCodeFenceRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /```[\s\S]*?```/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    ranges.push([match.index, match.index + match[0].length]);
    match = pattern.exec(text);
  }
  return ranges;
}

function isProtectedIndex(
  index: number,
  ranges: Array<[number, number]>,
): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

function extractThinkingBlocks(
  rawContent: string | null,
): ThinkingExtractionResult {
  if (rawContent == null) {
    return { thinking: null, content: null, thinkingOnly: false };
  }

  const content = String(rawContent);
  const lower = content.toLowerCase();
  const protectedRanges = findCodeFenceRanges(content);
  const thinkParts: string[] = [];
  const removals: Array<{ start: number; end: number }> = [];

  let cursor = 0;
  while (cursor < content.length) {
    let openIndex = lower.indexOf('<think>', cursor);
    while (openIndex >= 0 && isProtectedIndex(openIndex, protectedRanges)) {
      openIndex = lower.indexOf('<think>', openIndex + 1);
    }
    if (openIndex < 0) break;

    let closeIndex = lower.indexOf('</think>', openIndex + '<think>'.length);
    while (closeIndex >= 0 && isProtectedIndex(closeIndex, protectedRanges)) {
      closeIndex = lower.indexOf('</think>', closeIndex + 1);
    }

    const blockStart = openIndex + '<think>'.length;
    const blockEnd = closeIndex >= 0 ? closeIndex : content.length;
    thinkParts.push(content.slice(blockStart, blockEnd));
    removals.push({
      start: openIndex,
      end: closeIndex >= 0 ? closeIndex + '</think>'.length : content.length,
    });
    cursor = closeIndex >= 0 ? closeIndex + '</think>'.length : content.length;
  }

  if (thinkParts.length === 0) {
    return {
      thinking: null,
      content: content || null,
      thinkingOnly: false,
    };
  }

  let visible = '';
  let visibleCursor = 0;
  for (const removal of removals) {
    visible += content.slice(visibleCursor, removal.start);
    visibleCursor = removal.end;
  }
  visible += content.slice(visibleCursor);

  const normalizedContent = visible.replace(/\n{3,}/g, '\n\n').trim();
  const thinking = thinkParts.join('\n\n');
  const thinkingOnly = normalizedContent.length === 0;
  return {
    thinking,
    content: thinkingOnly ? 'Done.' : normalizedContent,
    thinkingOnly,
  };
}

function formatThinkingPreview(thinking: string | null): string | null {
  if (thinking == null) return null;
  const normalized = thinking.replace(/\r\n?/g, '\n');
  if (!normalized) return '';
  return normalized;
}

function wrapTuiLines(text: string, columns: number, indent = ''): string[] {
  const normalized = String(text || '').replace(/\r\n?/g, '\n');
  const contentWidth = Math.max(1, Math.floor(columns || 1) - indent.length);
  const lines = normalized.split('\n');
  const wrapped: string[] = [];

  for (const line of lines) {
    for (const segment of wrapPlainLine(line, contentWidth)) {
      wrapped.push(`${indent}${segment}`);
    }
  }

  return wrapped.length > 0 ? wrapped : [indent];
}

function wrapPlainLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];

  const wrapped: string[] = [];
  let remaining = line;

  while (remaining.length > width) {
    let breakAt = findWrapBoundary(remaining, width);
    let segment = remaining.slice(0, breakAt);

    if (segment.trim().length === 0) {
      breakAt = width;
      segment = remaining.slice(0, breakAt);
    } else {
      segment = segment.replace(/\s+$/u, '');
    }

    wrapped.push(segment);
    remaining = remaining.slice(breakAt);
    if (remaining.startsWith(' ')) {
      remaining = remaining.slice(1);
    }
  }

  wrapped.push(remaining);
  return wrapped;
}

function findWrapBoundary(text: string, width: number): number {
  for (let index = width; index > 0; index -= 1) {
    if (/\s/u.test(text[index - 1] || '')) {
      return index;
    }
  }
  return width;
}
