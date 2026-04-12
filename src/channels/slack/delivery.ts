import { SLACK_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';

const SLACK_PLACEHOLDER_SENTINEL = '\u0000SL';

export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text;
  if (toolsUsed && toolsUsed.length > 0) {
    body = `${body}\n_Tools: ${toolsUsed.join(', ')}_`;
  }
  return body;
}

export function formatSlackMrkdwn(content: string): string {
  if (!content) {
    return content;
  }

  const placeholders = new Map<string, string>();
  let placeholderIndex = 0;
  const stashPlaceholder = (value: string): string => {
    const key = `${SLACK_PLACEHOLDER_SENTINEL}${placeholderIndex}\u0000`;
    placeholderIndex += 1;
    placeholders.set(key, value);
    return key;
  };

  let text = content;

  // Preserve code regions verbatim so later markdown rewrites do not mangle them.
  text = text.replace(/(```(?:[^\n]*\n)?[\s\S]*?```)/g, (match) =>
    stashPlaceholder(match),
  );
  text = text.replace(/(`[^`]+`)/g, (match) => stashPlaceholder(match));

  text = text.replace(
    /\[([^\]]+)\]\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g,
    (_match, label: string, rawUrl: string) => {
      const trimmedUrl = rawUrl.trim();
      const url =
        trimmedUrl.startsWith('<') && trimmedUrl.endsWith('>')
          ? trimmedUrl.slice(1, -1).trim()
          : trimmedUrl;
      return stashPlaceholder(`<${url}|${label}>`);
    },
  );

  // Preserve Slack-native entities and manual links.
  text = text.replace(/(<(?:[@#!]|(?:https?|mailto|tel):)[^>\n]+>)/g, (match) =>
    stashPlaceholder(match),
  );

  text = text.replace(/^(>+\s)/gm, (match) => stashPlaceholder(match));

  text = text
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
  text = text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => {
    const inner = heading.trim().replace(/\*\*(.+?)\*\*/g, '$1');
    return stashPlaceholder(`*${inner}*`);
  });

  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_match, inner: string) =>
    stashPlaceholder(`*_${inner}_*`),
  );
  text = text.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) =>
    stashPlaceholder(`*${inner}*`),
  );
  text = text.replace(/~~(.+?)~~/g, (_match, inner: string) =>
    stashPlaceholder(`~${inner}~`),
  );

  for (const [key, value] of [...placeholders.entries()].reverse()) {
    text = text.replaceAll(key, value);
  }

  return text;
}

export function prepareSlackTextChunks(text: string): string[] {
  const chunks = chunkMessage(formatSlackMrkdwn(text), {
    maxChars: Math.max(200, Math.min(40_000, SLACK_TEXT_CHUNK_LIMIT)),
    maxLines: 200,
  })
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : ['(no content)'];
}
