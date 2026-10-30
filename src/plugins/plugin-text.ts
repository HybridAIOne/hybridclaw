/**
 * Text and transcript helpers for plugins that turn conversation history and
 * external tool output into prompt context. Every helper runs in linear time
 * on untrusted input and never throws on non-string values.
 *
 * NOT the gateway's own prompt budgeting (`src/session/token-efficiency.ts`);
 * these only shape what a plugin hands back.
 */

/** Drops `\r` and trailing line whitespace, and caps blank-line runs at one. */
export function normalizeText(
  value: unknown,
  options: { collapseSpaces?: boolean } = {},
): string {
  const text = String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return options.collapseSpaces ? text.replace(/[ \t]{2,}/g, ' ') : text;
}

/** Trims, then cuts to `maxChars` with a trailing `…`; no limit when unset. */
export function truncateText(value: unknown, maxChars?: number): string {
  const text = String(value || '').trim();
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/** Appends `[<subject> truncated]` on its own paragraph. */
export function appendTruncationNotice(text: string, subject: string): string {
  const notice = `[${subject} truncated]`;
  return text ? `${text}\n\n${notice}` : notice;
}

interface TranscriptMessage {
  role?: unknown;
  created_at?: unknown;
  id?: unknown;
}

function finiteOrLowest(value: number): number {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function isNewer(message: TranscriptMessage, than: TranscriptMessage): boolean {
  const time = finiteOrLowest(Date.parse(String(message.created_at || '')));
  const thanTime = finiteOrLowest(Date.parse(String(than.created_at || '')));
  if (time !== thanTime) return time > thanTime;
  return finiteOrLowest(Number(message.id)) >= finiteOrLowest(Number(than.id));
}

/**
 * The newest message with `role` (case-insensitive): latest `created_at`, then
 * highest numeric `id`, then the later array position. `recentMessages` is not
 * guaranteed to be in chronological order.
 */
export function latestMessageByRole<T extends TranscriptMessage>(
  messages: readonly T[] | null | undefined,
  role: string,
): T | null {
  let latest: T | null = null;
  for (const message of messages ?? []) {
    if (String(message?.role || '').toLowerCase() !== role) continue;
    if (!latest || isNewer(message, latest)) latest = message;
  }
  return latest;
}
