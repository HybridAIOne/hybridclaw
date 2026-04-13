const SOFT_STREAM_CHUNK_CHARS = 48;
const HARD_STREAM_CHUNK_CHARS = 120;

function stripMarkdownDelimiters(text: string): string {
  let result = text;

  result = result.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, '$1');
  result = result.replace(/`([^`\n]+)`/g, '$1');
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  result = result.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  result = result.replace(/^\s{0,3}>\s?/gm, '');
  result = result.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '');
  result = result.replace(/\*\*(.+?)\*\*/g, '$1');
  result = result.replace(/__(.+?)__/g, '$1');
  result = result.replace(/~~(.+?)~~/g, '$1');
  result = result.replace(
    /(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=($|[^\w*]))/g,
    '$1$2',
  );
  result = result.replace(
    /(^|[^\w_])_(\S(?:[^_\n]*?\S)?)_(?=($|[^\w_]))/g,
    '$1$2',
  );
  result = result.replace(/(^|[\s([{])(?:\*{1,3}|_{1,3}|~{1,2}|`{1,3})/g, '$1');
  result = result.replace(
    /(?:\*{1,3}|_{1,3}|~{1,2}|`{1,3})(?=($|[\s)\]},.!?;:]))/g,
    '',
  );
  return result;
}

export function formatTextForVoice(text: string): string {
  if (!text) return '';

  let result = String(text).replace(/\r\n/g, '\n');
  result = stripMarkdownDelimiters(result);
  result = result.replace(/https?:\/\/\S+/g, '');
  result = result.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1');
  result = result.replace(/[ \t]+\n/g, '\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  result = result.replace(/\n+/g, '. ');
  result = result.replace(/[ \t]{2,}/g, ' ');
  result = result.replace(/\s+([,.;!?])/g, '$1');
  result = result.replace(/([,.;!?])([^\s])/g, '$1 $2');
  return result.trim();
}

function findChunkBoundary(text: string): number {
  if (!text) return 0;

  let lastSentenceBoundary = 0;
  let lastWhitespaceBoundary = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (
      char === '\n' ||
      char === '.' ||
      char === '!' ||
      char === '?' ||
      char === ';' ||
      char === ':'
    ) {
      lastSentenceBoundary = index + 1;
    } else if (/\s/.test(char) || char === ',') {
      lastWhitespaceBoundary = index + 1;
    }
  }

  if (lastSentenceBoundary > 0) {
    return lastSentenceBoundary;
  }
  if (text.length >= HARD_STREAM_CHUNK_CHARS) {
    return lastWhitespaceBoundary > 0 ? lastWhitespaceBoundary : text.length;
  }
  if (text.length >= SOFT_STREAM_CHUNK_CHARS && lastWhitespaceBoundary > 0) {
    return lastWhitespaceBoundary;
  }
  return 0;
}

export function createVoiceTextStreamFormatter(): {
  push: (delta: string) => string[];
  flush: () => string[];
} {
  let buffered = '';

  return {
    push(delta: string): string[] {
      if (!delta) return [];
      buffered += delta;

      const emitted: string[] = [];
      while (true) {
        const boundary = findChunkBoundary(buffered);
        if (boundary <= 0) break;
        const chunk = formatTextForVoice(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary);
        if (chunk) {
          emitted.push(chunk);
        }
      }
      return emitted;
    },
    flush(): string[] {
      if (!buffered) return [];
      const chunk = formatTextForVoice(buffered);
      buffered = '';
      return chunk ? [chunk] : [];
    },
  };
}
