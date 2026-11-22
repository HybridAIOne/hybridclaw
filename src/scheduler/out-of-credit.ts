/**
 * Scheduled runs that HybridAI refused because the account is out of credit.
 * They are not broken routines: they run again once the free allowance resets
 * or credit is added, so they never count toward the auto-pause, and each chat
 * hears about it once, with the way to add credit, instead of once per run.
 *
 * The provider error crosses the container as text, so this reads the two
 * refusals HybridAI sends: the free allowance (with its reset time) and an
 * exhausted credit balance.
 */
import { HYBRIDAI_BASE_URL } from '../config/config.js';

const OUT_OF_CREDIT =
  /^Provider API error 429: .*(usage limit reached|allowance is exhausted|exceeded your current quota)/i;
const RESETS_AT = /after (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC/;
// Without a reset time, say it again a day later at the earliest.
const REPEAT_MS = 86_400_000;
// HybridAI's account page, where credit is added. The apps open their own
// plans screen for it instead.
const ADD_CREDIT_PATH = '/app/admin/account';

export interface OutOfCredit {
  resetsAt?: number;
}

export function outOfCredit(error: unknown): OutOfCredit | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!OUT_OF_CREDIT.test(message)) return null;
  const reset = RESETS_AT.exec(message);
  const resetsAt = reset ? Date.parse(`${reset[1]}T${reset[2]}:00Z`) : NaN;
  return Number.isFinite(resetsAt) ? { resetsAt } : {};
}

// Chat → until when it has been told.
const told = new Map<string, number>();

/**
 * The one message a chat gets while the account is out of credit, or null when
 * it already got it for this stretch.
 */
export function outOfCreditNotice(
  chat: string,
  credit: OutOfCredit,
  timeZone?: string | null,
  now = Date.now(),
): string | null {
  if ((told.get(chat) ?? 0) > now) return null;
  told.set(chat, credit.resetsAt ?? now + REPEAT_MS);
  const link = `[Add credit](${HYBRIDAI_BASE_URL.replace(/\/+$/, '')}${ADD_CREDIT_PATH})`;
  if (!credit.resetsAt)
    return `Hy is out of credit, so your routines are waiting. ${link} and they run again.`;
  const until = new Date(credit.resetsAt).toLocaleString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timeZone?.trim() || 'UTC',
    timeZoneName: 'short',
  });
  return `Hy's free use is used up until ${until}, so your routines wait until then. ${link} to keep them going now.`;
}

export function resetOutOfCreditNotices(): void {
  told.clear();
}
