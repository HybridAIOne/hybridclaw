/**
 * An email the agent drafted for the user to review: the `draft_email` tool's
 * arguments, checked once here so the tool and the gateway agree on what a
 * draft is. The apps show it as an email card with Send and Discard; drafting
 * sends nothing.
 */

/** A checked draft: every one has From, To and Subject. */
export interface EmailDraft {
  /** Existing tracked item receiving this draft for shared review. */
  track_id?: number;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  source?: string;
}
/** A draft as stored with the reply that showed it. */
export interface MessageEmailDraft extends EmailDraft {
  /** The agent's own words, without the draft. */
  reply: string;
  /** Drafted by a scheduled run rather than in answer to the user. */
  proactive?: true;
}

interface Checked<T> {
  ok?: true;
  value?: T;
  error?: string;
}

const ADDRESS_MAX = 320;
const SUBJECT_MAX = 998;
const SOURCE_MAX = 500;
const BODY_MAX = 20_000;
const PLAIN_ADDRESS = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

function line(value: unknown, max: number, field: string): Checked<string> {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string') return { error: `"${field}" must be text.` };
  const text = value.trim();
  if (!text) return { ok: true };
  if (/[\r\n]/.test(text)) return { error: `"${field}" must be one line.` };
  if (text.length > max) return { error: `"${field}" is too long.` };
  return { ok: true, value: text };
}

function addresses(value: unknown, field: string): Checked<string[]> {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value))
    return { error: `"${field}" must be a list of email addresses.` };
  const list: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (!text || text.length > ADDRESS_MAX || !PLAIN_ADDRESS.test(text)) {
      return {
        error: `"${field}" must hold plain email addresses such as name@example.com.`,
      };
    }
    list.push(text);
  }
  return { ok: true, value: list };
}

const FROM_MISSING =
  '"from" is required: the user’s own address in the connected mail account the email is sent from. For a reply, use the address the original email was sent to; for a new email, look it up in that account first, such as the sender of a mail in their Sent folder. Never guess it.';
const TO_MISSING =
  '"to" is required: at least one recipient address. For a reply, use the original sender or its Reply-To. Never guess it; ask the user when you cannot find it.';
const SUBJECT_MISSING =
  '"subject" is required. For a reply, use the original subject with Re: in front.';

export function normalizeEmailDraft(
  input: unknown,
):
  | { draft: EmailDraft; error?: undefined }
  | { error: string; draft?: undefined } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { error: 'Give the draft as an object.' };
  const args = input as Record<string, unknown>;
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (!body) return { error: '"body" is required.' };
  if (body.length > BODY_MAX) return { error: '"body" is too long.' };
  const draft: Partial<EmailDraft> = {};
  if (args.track_id !== undefined) {
    if (
      typeof args.track_id !== 'number' ||
      !Number.isSafeInteger(args.track_id) ||
      args.track_id < 1
    )
      return { error: '"track_id" must be an existing positive item id.' };
    draft.track_id = args.track_id;
  }
  for (const [field, max] of [
    ['from', ADDRESS_MAX],
    ['subject', SUBJECT_MAX],
    ['source', SOURCE_MAX],
  ] as const) {
    const checked = line(args[field], max, field);
    if (checked.error) return { error: checked.error };
    if (checked.value) draft[field] = checked.value;
  }
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const checked = addresses(args[field], field);
    if (checked.error) return { error: checked.error };
    if (checked.value?.length) draft[field] = checked.value;
  }
  // Every draft names its sender, recipients and subject: the apps show an
  // email card only with all three.
  if (!draft.from) return { error: FROM_MISSING };
  if (!PLAIN_ADDRESS.test(draft.from))
    return {
      error: '"from" must be one plain email address such as name@example.com.',
    };
  if (!draft.to) return { error: TO_MISSING };
  if (!draft.subject) return { error: SUBJECT_MISSING };
  draft.body = body;
  return { draft: draft as EmailDraft };
}

/**
 * The draft as plain text, stored with the reply: channels without the card,
 * the web chat and later turns of the conversation read it there. Fenced, so
 * no link or picture in it renders.
 */
export function emailDraftText(draft: EmailDraft): string {
  const longest = Math.max(
    2,
    ...(draft.body.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = '`'.repeat(longest + 1);
  const header = [
    draft.from ? `From: ${draft.from}` : '',
    draft.to ? `To: ${draft.to.join(', ')}` : '',
    draft.cc ? `Cc: ${draft.cc.join(', ')}` : '',
    draft.bcc ? `Bcc: ${draft.bcc.join(', ')}` : '',
    draft.subject ? `Subject: ${draft.subject}` : '',
  ].filter(Boolean);
  return [
    '**Email draft (not sent)**',
    `${fence}text`,
    ...(header.length ? [...header, ''] : []),
    draft.body,
    fence,
  ].join('\n');
}
