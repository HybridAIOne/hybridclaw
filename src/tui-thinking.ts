export function formatTuiStreamDelta(
  delta: string,
  lineNeedsIndent: boolean,
): { text: string; lineNeedsIndent: boolean } {
  const normalizedDelta = String(delta || '');
  if (!normalizedDelta) {
    return {
      text: '',
      lineNeedsIndent,
    };
  }

  const normalized = normalizedDelta.replace(/\r\n?/g, '\n');
  let text = '';
  let needsIndent = lineNeedsIndent;

  for (const char of normalized) {
    if (needsIndent) {
      text += '  ';
      needsIndent = false;
    }
    text += char;
    if (char === '\n') {
      needsIndent = true;
    }
  }

  return {
    text,
    lineNeedsIndent: needsIndent,
  };
}

export function countTerminalRows(text: string, columns: number): number {
  const width = Math.max(1, columns || 1);
  const lines = String(text || '').split('\n');
  let rows = 0;

  for (const line of lines) {
    rows += Math.max(1, Math.ceil(line.length / width) || 1);
  }

  return rows;
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

function extractThinkingBlocks(rawContent: string | null): ThinkingExtractionResult {
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
