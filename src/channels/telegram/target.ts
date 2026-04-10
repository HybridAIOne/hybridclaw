const TELEGRAM_PREFIX_RE = /^(telegram|tg):/i;
const TELEGRAM_USERNAME_RE = /^@?[a-z][a-z0-9_]{4,31}$/i;
const TELEGRAM_NUMERIC_ID_RE = /^-?\d+$/;

export interface ParsedTelegramTarget {
  chatId: string;
  topicId?: number;
  chatHint?: 'direct' | 'group';
}

function normalizeTopicId(value: string): number | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

export function normalizeTelegramChatId(value: string): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  if (TELEGRAM_NUMERIC_ID_RE.test(trimmed)) return trimmed;
  if (!TELEGRAM_USERNAME_RE.test(trimmed)) return undefined;
  return trimmed.startsWith('@')
    ? trimmed.toLowerCase()
    : `@${trimmed.toLowerCase()}`;
}

export function parseTelegramTarget(
  value: string,
): ParsedTelegramTarget | null {
  let normalized = String(value || '').trim();
  if (!normalized) return null;

  normalized = normalized.replace(TELEGRAM_PREFIX_RE, '').trim();
  if (!normalized) return null;

  let topicId: number | undefined;
  const topicMatch = normalized.match(/:topic:(\d+)$/i);
  if (topicMatch) {
    topicId = normalizeTopicId(topicMatch[1]);
    normalized = normalized.slice(0, topicMatch.index).trim();
  }

  let chatHint: ParsedTelegramTarget['chatHint'];
  const hintMatch = normalized.match(/^(dm|direct|group|chat|channel):(.+)$/i);
  if (hintMatch) {
    chatHint =
      hintMatch[1].toLowerCase() === 'dm' ||
      hintMatch[1].toLowerCase() === 'direct'
        ? 'direct'
        : 'group';
    normalized = hintMatch[2].trim();
  }

  const chatId = normalizeTelegramChatId(normalized);
  if (!chatId) return null;

  return {
    chatId,
    ...(topicId ? { topicId } : {}),
    ...(chatHint ? { chatHint } : {}),
  };
}

export function buildTelegramChannelId(
  chatId: string,
  topicId?: number | null,
): string {
  const normalizedChatId = normalizeTelegramChatId(chatId);
  if (!normalizedChatId) {
    throw new Error(`Invalid Telegram chat id: ${chatId}`);
  }
  const normalizedTopicId =
    topicId == null ? undefined : normalizeTopicId(String(topicId));
  return normalizedTopicId
    ? `telegram:${normalizedChatId}:topic:${normalizedTopicId}`
    : `telegram:${normalizedChatId}`;
}

export function normalizeTelegramChannelId(value: string): string | undefined {
  const parsed = parseTelegramTarget(value);
  if (!parsed) return undefined;
  return buildTelegramChannelId(parsed.chatId, parsed.topicId);
}

export function normalizeTelegramSendTargetId(
  value: string,
): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed || !TELEGRAM_PREFIX_RE.test(trimmed)) return undefined;

  const parsed = parseTelegramTarget(trimmed);
  if (!parsed || !TELEGRAM_NUMERIC_ID_RE.test(parsed.chatId)) return undefined;

  return buildTelegramChannelId(parsed.chatId, parsed.topicId);
}

export function isTelegramChannelId(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed || !TELEGRAM_PREFIX_RE.test(trimmed)) return false;
  return Boolean(normalizeTelegramChannelId(trimmed));
}

export function isTelegramSendTargetId(value: string): boolean {
  return Boolean(normalizeTelegramSendTargetId(value));
}

export function resolveTelegramTargetChatType(
  value: string,
): 'direct' | 'group' | 'unknown' {
  const parsed = parseTelegramTarget(value);
  if (!parsed) return 'unknown';
  if (parsed.chatHint) return parsed.chatHint;
  if (parsed.chatId.startsWith('-')) return 'group';
  if (parsed.chatId.startsWith('@')) return 'unknown';
  return 'direct';
}
