const SOFT_STREAM_CHUNK_CHARS = 48;
const HARD_STREAM_CHUNK_CHARS = 120;

function normalizeVoiceApprovalCandidate(text: string): string {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\bfor\s+(?:a|an|the)\s+(session|agent|all)\b/g, 'for $1')
    .replace(/\bplease\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeVoiceUserTextForGateway(text: string): string {
  const normalized = normalizeVoiceApprovalCandidate(text);
  if (!normalized) {
    return text;
  }

  // Keep these STT-tolerant approval aliases aligned with the canonical
  // approval reply vocabulary in container/src/approval-policy.ts.
  if (normalized === 'yes' || normalized === 'approve') {
    return 'yes';
  }
  if (normalized === 'yes for session' || normalized === 'for session') {
    return 'yes for session';
  }
  if (normalized === 'yes for agent' || normalized === 'for agent') {
    return 'yes for agent';
  }
  if (normalized === 'yes for all' || normalized === 'for all') {
    return 'yes for all';
  }
  if (
    normalized === 'no' ||
    normalized === 'skip' ||
    normalized === 'deny' ||
    normalized === 'reject' ||
    normalized === 'skip it'
  ) {
    return 'no';
  }

  return text;
}

function stripMarkdownDelimiters(text: string): string {
  let result = text;

  result = result.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, '$1');
  result = result.replace(/`([^`\n]+)`/g, '$1');
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  result = stripLeadingOrphanMarkerRuns(result);
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
  return result;
}

function isStandaloneMarkerToken(token: string): boolean {
  return token.length === 1 && '*_~`'.includes(token);
}

function stripLeadingOrphanMarkerRuns(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
      const trimmed = line.slice(leadingWhitespace.length);
      if (!trimmed) return line;

      const tokens = trimmed.split(/\s+/);
      let markerCount = 0;
      while (
        markerCount < tokens.length &&
        isStandaloneMarkerToken(tokens[markerCount] || '')
      ) {
        markerCount += 1;
      }
      if (markerCount < 3) {
        return line;
      }
      const remainder = tokens.slice(markerCount).join(' ').trimStart();
      const normalizedRemainder = remainder.replace(/^(?:[*_~`]{1,3})+/, '');
      if (!/^[A-Za-z]/.test(normalizedRemainder)) {
        return line;
      }
      return `${leadingWhitespace}${remainder}`;
    })
    .join('\n');
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
