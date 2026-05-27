export type ParsedAuditSearch = {
  sessionId: string;
  eventType: string;
  query: string;
};

type Token =
  | { kind: 'field'; key: 'session' | 'type'; value: string; raw: string }
  | { kind: 'text'; value: string; raw: string };

const FIELD_ALIASES: Record<string, 'session' | 'type'> = {
  session: 'session',
  type: 'type',
  event: 'type',
};

/**
 * Tokenize a search string while respecting double-quoted segments.
 * `session:"web one" hello "two words" type:tool` →
 *   ['session:"web one"', 'hello', '"two words"', 'type:tool']
 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let buffer = '';
  let inQuotes = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buffer += ch;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer) out.push(buffer);
  return out;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  // Tolerate an unterminated quote on either side (user mid-typing, or a
  // pasted value carrying one stray `"`) so the quote never leaks into the
  // parsed token.
  if (value.startsWith('"')) {
    return value.slice(1);
  }
  if (value.endsWith('"')) {
    return value.slice(0, -1);
  }
  return value;
}

function classify(raw: string): Token {
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    const key = raw.slice(0, colonIdx).toLowerCase();
    const normalizedKey = FIELD_ALIASES[key];
    if (normalizedKey) {
      return {
        kind: 'field',
        key: normalizedKey,
        value: stripQuotes(raw.slice(colonIdx + 1)),
        raw,
      };
    }
  }
  return { kind: 'text', value: stripQuotes(raw), raw };
}

/**
 * Parse a smart-search input into structured filter values.
 * `session:web type:tool error` → { sessionId: 'web', eventType: 'tool', query: 'error' }
 * Field tokens later in the string override earlier ones; free text joins with single spaces.
 */
export function parseAuditSearch(input: string): ParsedAuditSearch {
  const tokens = tokenize(input).map(classify);
  let sessionId = '';
  let eventType = '';
  const text: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'field') {
      if (token.key === 'session') sessionId = token.value;
      else eventType = token.value;
    } else if (token.value) {
      text.push(token.value);
    }
  }
  return { sessionId, eventType, query: text.join(' ') };
}

/**
 * Remove a specific field token (`session:` or `type:`) from a raw search
 * string, preserving free text. Used when the user dismisses a chip.
 */
export function removeAuditField(
  input: string,
  field: 'session' | 'type',
): string {
  return tokenize(input)
    .map(classify)
    .filter((token) => !(token.kind === 'field' && token.key === field))
    .map((token) => token.raw)
    .join(' ');
}

/**
 * Replace or add a field token, preserving free text and other field tokens.
 * Quotes the value if it contains whitespace.
 */
export function setAuditField(
  input: string,
  field: 'session' | 'type',
  value: string,
): string {
  const trimmed = value.trim();
  const stripped = removeAuditField(input, field);
  if (!trimmed) return stripped;
  const quoted = /\s/.test(trimmed) ? `"${trimmed}"` : trimmed;
  const piece = `${field}:${quoted}`;
  return stripped ? `${stripped} ${piece}` : piece;
}
