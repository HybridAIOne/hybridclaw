export type ContextReferenceKind =
  | 'diff'
  | 'file'
  | 'folder'
  | 'git'
  | 'staged'
  | 'url';

export interface ContextReference {
  kind: ContextReferenceKind;
  raw: string;
  value: string | null;
  start: number;
  end: number;
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  commitCount?: number;
  url?: string;
}

export interface ContextReferenceResult {
  originalMessage: string;
  strippedMessage: string;
  message: string;
  references: ContextReference[];
  warnings: string[];
  attachedContext: string | null;
  contextTokens: number;
}

const CONTEXT_REFERENCE_RE =
  /(?<![\w/])@(?:(?<simple>diff|staged)\b|(?<kind>file|folder|git|url):(?<value>\S+))/gu;
const TRAILING_PUNCTUATION_RE = /[.,;!?]+$/u;
const TRAILING_BRACKETS = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
] as const;

function countChar(text: string, char: string): number {
  let count = 0;
  for (const value of text) {
    if (value === char) count += 1;
  }
  return count;
}

function parseFileValue(value: string): {
  path: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const match = value.match(/^(.*?):(\d+)(?:-(\d+))?$/u);
  if (!match || !match[1]) {
    return { path: value };
  }

  const lineStart = Number.parseInt(match[2] || '', 10);
  const lineEnd = Number.parseInt(match[3] || match[2] || '', 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return { path: value };
  }

  return {
    path: match[1],
    lineStart: Math.min(lineStart, lineEnd),
    lineEnd: Math.max(lineStart, lineEnd),
  };
}

function collapseReferenceWhitespace(message: string): string {
  return message
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/\s+([,.;!?])/gu, '$1')
    .replace(/\s+([([{])/gu, '$1')
    .replace(/([([{])\s+/gu, '$1')
    .replace(/\s+([)\]}])/gu, '$1')
    .trim();
}

export function stripTrailingPunctuation(value: string): string {
  let stripped = value.replace(TRAILING_PUNCTUATION_RE, '');

  while (stripped) {
    const pair = TRAILING_BRACKETS.find(([, close]) =>
      stripped.endsWith(close),
    );
    if (!pair) break;

    const [open, close] = pair;
    if (countChar(stripped, close) <= countChar(stripped, open)) break;

    stripped = stripped
      .slice(0, Math.max(0, stripped.length - 1))
      .replace(TRAILING_PUNCTUATION_RE, '');
  }

  return stripped;
}

export function parseContextReferences(message: string): ContextReference[] {
  if (!message) return [];

  const references: ContextReference[] = [];
  for (const match of message.matchAll(CONTEXT_REFERENCE_RE)) {
    const start = match.index ?? 0;
    const simple = match.groups?.simple as 'diff' | 'staged' | undefined;
    if (simple) {
      references.push({
        kind: simple,
        raw: match[0],
        value: null,
        start,
        end: start + match[0].length,
      });
      continue;
    }

    const kind = match.groups?.kind as
      | 'file'
      | 'folder'
      | 'git'
      | 'url'
      | undefined;
    const rawValue = match.groups?.value ?? '';
    const value = stripTrailingPunctuation(rawValue);
    if (!kind || !value) continue;

    const trimmedLength = rawValue.length - value.length;
    const end = start + match[0].length - trimmedLength;
    const reference: ContextReference = {
      kind,
      raw: message.slice(start, end),
      value,
      start,
      end,
    };

    if (kind === 'file') {
      const parsed = parseFileValue(value);
      reference.path = parsed.path;
      reference.lineStart = parsed.lineStart;
      reference.lineEnd = parsed.lineEnd;
    } else if (kind === 'folder') {
      reference.path = value;
    } else if (kind === 'git') {
      const commitCount = Number.parseInt(value, 10);
      if (Number.isFinite(commitCount)) {
        reference.commitCount = commitCount;
      }
    } else if (kind === 'url') {
      reference.url = value;
    }

    references.push(reference);
  }

  return references;
}

export function removeReferenceTokens(
  message: string,
  refs: ContextReference[],
): string {
  if (!message || refs.length === 0) return message;

  const sorted = [...refs].sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;

  for (const ref of sorted) {
    if (ref.start > cursor) {
      parts.push(message.slice(cursor, ref.start));
    }
    parts.push(' ');
    cursor = ref.end;
  }

  if (cursor < message.length) {
    parts.push(message.slice(cursor));
  }

  return collapseReferenceWhitespace(parts.join(''));
}
