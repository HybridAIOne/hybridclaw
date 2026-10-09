/**
 * Text shaping between the caller's speech and the agent's streamed reply.
 *
 * Caller transcripts that are exactly an approval reply ("Yes, for the
 * session.") collapse to the canonical approval vocabulary so speech
 * recognition punctuation never blocks an approval; any other transcript
 * passes through untouched. Reply deltas are cut at sentence (or, for long
 * runs, whitespace) boundaries and formatted for speech by the core
 * formatter passed in, so TTS starts early without reading half-words.
 */

const SOFT_CHUNK_CHARS = 48;
const HARD_CHUNK_CHARS = 120;
const SENTENCE_BOUNDARY_CHARS = new Set(['\n', '.', '!', '?', ';', ':']);

// Keep aligned with the approval reply vocabulary in
// container/src/approval-policy.ts.
const APPROVAL_REPLIES = {
  yes: 'yes',
  approve: 'yes',
  'yes for session': 'yes for session',
  'for session': 'yes for session',
  'yes for agent': 'yes for agent',
  'for agent': 'yes for agent',
  'yes for all': 'yes for all',
  'for all': 'yes for all',
  no: 'no',
  skip: 'no',
  'skip it': 'no',
  deny: 'no',
  reject: 'no',
};

export function normalizeCallerSpeech(text) {
  const candidate = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\bfor\s+(?:a|an|the)\s+(session|agent|all)\b/g, 'for $1')
    .replace(/\bplease\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Object.hasOwn(APPROVAL_REPLIES, candidate)
    ? APPROVAL_REPLIES[candidate]
    : text;
}

function findChunkBoundary(text) {
  let sentenceBoundary = 0;
  let whitespaceBoundary = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (SENTENCE_BOUNDARY_CHARS.has(char)) {
      sentenceBoundary = index + 1;
    } else if (/\s/.test(char) || char === ',') {
      whitespaceBoundary = index + 1;
    }
  }
  if (sentenceBoundary > 0) return sentenceBoundary;
  if (text.length >= HARD_CHUNK_CHARS) {
    return whitespaceBoundary > 0 ? whitespaceBoundary : text.length;
  }
  if (text.length >= SOFT_CHUNK_CHARS && whitespaceBoundary > 0) {
    return whitespaceBoundary;
  }
  return 0;
}

export function createSpeechChunker(formatForSpeech) {
  let buffered = '';
  return {
    push(delta) {
      if (!delta) return [];
      buffered += delta;
      const chunks = [];
      for (
        let boundary = findChunkBoundary(buffered);
        boundary > 0;
        boundary = findChunkBoundary(buffered)
      ) {
        const chunk = formatForSpeech(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary);
        if (chunk) chunks.push(chunk);
      }
      return chunks;
    },
    flush() {
      const chunk = buffered ? formatForSpeech(buffered) : '';
      buffered = '';
      return chunk ? [chunk] : [];
    },
  };
}
