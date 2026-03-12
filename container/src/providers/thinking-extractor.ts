export interface ThinkingExtractionResult {
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

export function extractThinkingBlocks(
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

export function createThinkingDeltaFilter(
  onTextDelta: (delta: string) => void,
): {
  push: (delta: string) => void;
  getRawContent: () => string;
  getVisibleContent: () => string;
} {
  let rawContent = '';
  let emittedVisibleContent = '';

  return {
    push(delta: string): void {
      if (!delta) return;
      rawContent += delta;
      const extracted = extractThinkingBlocks(rawContent);
      const nextVisible = extracted.thinkingOnly ? '' : extracted.content || '';
      if (!nextVisible.startsWith(emittedVisibleContent)) return;
      const visibleDelta = nextVisible.slice(emittedVisibleContent.length);
      emittedVisibleContent = nextVisible;
      if (visibleDelta) onTextDelta(visibleDelta);
    },
    getRawContent(): string {
      return rawContent;
    },
    getVisibleContent(): string {
      const extracted = extractThinkingBlocks(rawContent);
      return extracted.thinkingOnly ? '' : extracted.content || '';
    },
  };
}

export function createThinkingStreamEmitter(
  onTextDelta: (delta: string) => void,
): {
  pushRaw: (delta: string) => void;
  pushVisible: (delta: string) => void;
  pushThinking: (delta: string) => void;
  close: () => void;
  getRawContent: () => string;
  getVisibleContent: () => string;
} {
  let rawContent = '';
  let syntheticThinkingOpen = false;

  const emit = (delta: string): void => {
    if (!delta) return;
    rawContent += delta;
    onTextDelta(delta);
  };

  return {
    pushRaw(delta: string): void {
      emit(delta);
    },
    pushVisible(delta: string): void {
      if (!delta) return;
      if (syntheticThinkingOpen) {
        emit('</think>');
        syntheticThinkingOpen = false;
      }
      emit(delta);
    },
    pushThinking(delta: string): void {
      if (!delta) return;
      if (!syntheticThinkingOpen) {
        emit('<think>');
        syntheticThinkingOpen = true;
      }
      emit(delta);
    },
    close(): void {
      if (!syntheticThinkingOpen) return;
      emit('</think>');
      syntheticThinkingOpen = false;
    },
    getRawContent(): string {
      return rawContent;
    },
    getVisibleContent(): string {
      const extracted = extractThinkingBlocks(rawContent);
      return extracted.thinkingOnly ? '' : extracted.content || '';
    },
  };
}
