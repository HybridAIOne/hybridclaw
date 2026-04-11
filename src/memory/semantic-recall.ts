export type MemoryQueryMode = 'raw' | 'no-stopwords';
export type MemoryRecallBackend = 'full-text' | 'cosine' | 'hybrid';
export type MemoryRecallRerank = 'none' | 'bm25';
export type MemoryRecallTokenizer = 'unicode61' | 'porter' | 'trigram';

const MEMORY_RECALL_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'there',
  'they',
  'this',
  'to',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'you',
  'your',
]);

export function normalizeMemoryRecallText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeMemoryRecallQuery(
  value: string,
  maxTerms = 12,
  tokenizer: MemoryRecallTokenizer = 'unicode61',
): string[] {
  const terms =
    tokenizer === 'trigram'
      ? tokenizeMemoryRecallTrigrams(value)
      : tokenizeMemoryRecallTerms(value);
  const unique = new Set<string>();
  for (const term of terms) {
    unique.add(term);
    if (unique.size >= Math.max(1, Math.floor(maxTerms))) {
      break;
    }
  }
  return [...unique];
}

function tokenizeMemoryRecallTerms(value: string): string[] {
  return normalizeMemoryRecallText(value)
    .split(' ')
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function tokenizeMemoryRecallTrigrams(value: string): string[] {
  const tokens = tokenizeMemoryRecallTerms(value);
  const trigrams: string[] = [];
  for (const token of tokens) {
    if (token.length < 3) {
      trigrams.push(token);
      continue;
    }
    for (let index = 0; index <= token.length - 3; index += 1) {
      trigrams.push(token.slice(index, index + 3));
    }
  }
  return trigrams;
}

export function prepareMemoryRecallQuery(
  query: string,
  mode: MemoryQueryMode,
): string {
  const normalized = normalizeMemoryRecallText(query);
  if (mode !== 'no-stopwords') {
    return normalized;
  }
  const filtered = tokenizeMemoryRecallQuery(normalized).filter(
    (term) => !MEMORY_RECALL_STOPWORDS.has(term),
  );
  return filtered.length > 0 ? filtered.join(' ') : normalized;
}

export function normalizeMemoryRecallBackend(
  value: unknown,
  fallback: MemoryRecallBackend,
): MemoryRecallBackend {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'full-text' || normalized === 'fulltext') {
    return 'full-text';
  }
  if (normalized === 'fts-bm25') {
    return 'full-text';
  }
  if (normalized === 'hybrid') {
    return 'hybrid';
  }
  if (normalized === 'cosine' || normalized === 'semantic') {
    return 'cosine';
  }
  return fallback;
}

export function normalizeMemoryRecallRerank(
  value: unknown,
  fallback: MemoryRecallRerank,
): MemoryRecallRerank {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'bm25') {
    return 'bm25';
  }
  if (normalized === 'none') {
    return 'none';
  }
  return fallback;
}

export function normalizeMemoryRecallTokenizer(
  value: unknown,
  fallback: MemoryRecallTokenizer,
): MemoryRecallTokenizer {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'unicode61' || normalized === 'default') {
    return 'unicode61';
  }
  if (normalized === 'porter') {
    return 'porter';
  }
  if (normalized === 'trigram') {
    return 'trigram';
  }
  return fallback;
}

export function buildMemoryFtsMatchQuery(
  query: string,
  maxTerms = 12,
  tokenizer: MemoryRecallTokenizer = 'unicode61',
): string {
  const terms =
    tokenizer === 'trigram'
      ? tokenizeMemoryRecallQuery(query, maxTerms, 'unicode61')
      : tokenizeMemoryRecallQuery(query, maxTerms, tokenizer);
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

export function buildMemoryFtsDocument(
  content: string,
  _tokenizer: MemoryRecallTokenizer = 'unicode61',
): string {
  return content;
}

export function getMemoryFtsTokenizerSpec(
  tokenizer: MemoryRecallTokenizer,
): string {
  if (tokenizer === 'porter') {
    return 'porter unicode61';
  }
  if (tokenizer === 'trigram') {
    return 'trigram';
  }
  return 'unicode61';
}
