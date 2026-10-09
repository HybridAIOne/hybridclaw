/**
 * Spoken-output formatting shared by every voice surface: the web console
 * voice, plugin realtime sessions, and phone transport plugins (through
 * `api.formatTextForSpeech`). Strips markdown, links, and line structure so a
 * TTS engine reads prose, never syntax.
 *
 * NOT a chunker or a transcript normalizer: streaming segmentation and
 * caller-speech handling belong to the transport that owns the call.
 */
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
