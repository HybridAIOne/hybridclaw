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
