import type { StoredMessage } from '../types/session.js';

export const RECENT_CHAT_SESSION_TITLE_MAX_LENGTH = 120;
export const SESSIONS_COMMAND_SNIPPET_MAX_LENGTH = 40;
export const AGENT_CARD_PREVIEW_MAX_LENGTH = 180;

export function trimSessionPreviewText(
  raw: string | null | undefined,
  maxLength = 160,
): string | null {
  const compact = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return null;
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 3).trimEnd()}...`
    : compact;
}

export function buildSessionBoundaryPreview(params: {
  firstMessage?: string | null;
  lastMessage?: string | null;
  maxLength?: number;
}): string | null {
  const firstMessage = trimSessionPreviewText(
    params.firstMessage,
    params.maxLength,
  );
  const lastMessage = trimSessionPreviewText(
    params.lastMessage,
    params.maxLength,
  );

  if (firstMessage && lastMessage && firstMessage !== lastMessage) {
    return `"${firstMessage}" ... "${lastMessage}"`;
  }

  const single = firstMessage || lastMessage;
  return single ? `"${single}"` : null;
}

export function buildSessionSearchSnippet(
  raw: string | null | undefined,
  query: string | null | undefined,
  maxLength = 120,
): string | null {
  const compact = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return null;

  const normalizedQuery = String(query || '')
    .trim()
    .toLowerCase();
  if (!normalizedQuery) {
    return trimSessionPreviewText(compact, maxLength);
  }

  const matchIndex = compact.toLowerCase().indexOf(normalizedQuery);
  if (matchIndex < 0) {
    return trimSessionPreviewText(compact, maxLength);
  }

  const surroundingChars = Math.max(
    18,
    Math.floor((maxLength - normalizedQuery.length) / 2),
  );
  const start = Math.max(0, matchIndex - surroundingChars);
  const end = Math.min(
    compact.length,
    matchIndex + normalizedQuery.length + surroundingChars,
  );

  let snippet = compact.slice(start, end).trim();
  if (!snippet) return null;
  if (start > 0) snippet = `...${snippet}`;
  if (end < compact.length) snippet = `${snippet}...`;
  return trimSessionPreviewText(snippet, maxLength);
}

function normalizeSessionPreviewComparisonText(
  raw: string | null | undefined,
): string {
  return String(raw || '')
    .replace(/^\.\.\./, '')
    .replace(/\.\.\.$/, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function shouldIncludeSessionSearchSnippet(
  title: string | null | undefined,
  snippet: string | null | undefined,
): boolean {
  const normalizedSnippet = normalizeSessionPreviewComparisonText(snippet);
  if (!normalizedSnippet) return false;

  const normalizedTitle = normalizeSessionPreviewComparisonText(title);
  if (!normalizedTitle) return true;

  return !normalizedTitle.includes(normalizedSnippet);
}

export function buildSessionConversationPreview(
  messages: Array<Pick<StoredMessage, 'role' | 'content'>>,
  maxLength = 140,
): {
  lastQuestion: string | null;
  lastAnswer: string | null;
} {
  let pendingAnswer: string | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = String(message.role || '').toLowerCase();
    const preview = trimSessionPreviewText(message.content, maxLength);
    if (!preview) continue;

    if (role === 'assistant') {
      if (!pendingAnswer) {
        pendingAnswer = preview;
      }
      continue;
    }

    if (role === 'user') {
      return {
        lastQuestion: preview,
        lastAnswer: pendingAnswer,
      };
    }
  }

  return {
    lastQuestion: null,
    lastAnswer: pendingAnswer,
  };
}
