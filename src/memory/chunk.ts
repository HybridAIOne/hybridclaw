export interface ChunkMessageOptions {
  maxChars?: number;
  maxLines?: number;
}

const DEFAULT_MAX_CHARS = 1_900;
const DEFAULT_MAX_LINES = 20;

function isFenceLine(line: string): boolean {
  return line.trim().startsWith('```');
}

function parseFenceLanguage(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('```')) return '';
  return trimmed.slice(3).trim();
}

function findSentenceBoundary(input: string): number {
  let best = -1;
  const re = /[.!?]\s+/g;
  for (let match = re.exec(input); match; match = re.exec(input)) {
    best = match.index + match[0].length;
  }
  return best;
}

function findPreferredSplit(input: string, hardLimit: number): number {
  const limit = Math.max(1, Math.min(hardLimit, input.length));
  const window = input.slice(0, limit);

  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph >= Math.floor(limit * 0.45)) {
    return paragraph + 2;
  }

  const line = window.lastIndexOf('\n');
  if (line >= Math.floor(limit * 0.45)) {
    return line + 1;
  }

  const sentence = findSentenceBoundary(window);
  if (sentence >= Math.floor(limit * 0.45)) {
    return sentence;
  }

  const word = window.lastIndexOf(' ');
  if (word >= Math.floor(limit * 0.35)) {
    return word + 1;
  }

  return limit;
}

function splitLongLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];

  const pieces: string[] = [];
  let remaining = line;
  while (remaining.length > maxChars) {
    let splitAt = findPreferredSplit(remaining, maxChars);
    if (splitAt <= 0 || splitAt > remaining.length) {
      splitAt = Math.min(maxChars, remaining.length);
    }

    const head = remaining.slice(0, splitAt).trimEnd();
    if (!head) {
      const fallback = remaining.slice(0, maxChars);
      pieces.push(fallback);
      remaining = remaining.slice(maxChars);
      continue;
    }

    pieces.push(head);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    pieces.push(remaining);
  }

  return pieces;
}

export function chunkMessage(
  text: string,
  opts?: ChunkMessageOptions,
): string[] {
  const maxChars = Math.max(200, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  const maxLines = Math.max(4, opts?.maxLines ?? DEFAULT_MAX_LINES);
  const normalized = (text || '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) return [];

  const inputLines = normalized.split('\n');
  const chunks: string[] = [];

  let currentLines: string[] = [];
  let currentChars = 0;
  let openFence = false;
  let fenceLanguage = '';

  const flush = (isFinal: boolean): void => {
    if (currentLines.length === 0) return;

    let chunk = currentLines.join('\n');
    if (openFence) {
      chunk += '\n```';
    }
    chunks.push(chunk);

    if (!isFinal && openFence) {
      const reopenedFence = fenceLanguage ? `\`\`\`${fenceLanguage}` : '```';
      currentLines = [reopenedFence];
      currentChars = reopenedFence.length;
    } else {
      currentLines = [];
      currentChars = 0;
      if (isFinal && openFence) {
        openFence = false;
        fenceLanguage = '';
      }
    }
  };

  const appendLine = (line: string): void => {
    const addedChars =
      currentLines.length === 0 ? line.length : line.length + 1;
    const nextChars = currentChars + addedChars;
    const nextLines = currentLines.length + 1;
    if (
      currentLines.length > 0 &&
      (nextChars > maxChars || nextLines > maxLines)
    ) {
      flush(false);
    }

    currentLines.push(line);
    currentChars =
      currentLines.length === 1 ? line.length : currentChars + line.length + 1;

    if (isFenceLine(line)) {
      if (!openFence) {
        openFence = true;
        fenceLanguage = parseFenceLanguage(line);
      } else {
        openFence = false;
        fenceLanguage = '';
      }
    }
  };

  for (const rawLine of inputLines) {
    const splitLines = splitLongLine(rawLine, maxChars);
    for (const part of splitLines) {
      appendLine(part);
    }
  }

  flush(true);
  return chunks;
}
