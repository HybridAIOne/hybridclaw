import { normalizeEmailAddress } from './allowlist.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';

const REPLY_SUBJECT_RE = /^re(?:\[\d+\])?:\s*/i;
// RFC 5322 msg-id, narrowed to what mail actually carries: `<left@right>`,
// no whitespace, angle brackets, or control characters inside either half.
const MESSAGE_ID_RE = /^<[^<>\s@]+@[^<>\s@]+>$/;

export interface ThreadContext {
  subject: string;
  messageId: string;
  references: string[];
}

export interface EmailThreadTracker {
  get: (sender: string) => ThreadContext | null;
  remember: (sender: string, context: ThreadContext) => void;
  forget: (sender: string) => void;
  clear: () => void;
}

function normalizeMessageId(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  return trimmed || null;
}

function normalizeReferenceList(
  value: string[] | string | null | undefined,
): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [
    ...new Set(
      list
        .map((entry) => normalizeMessageId(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function normalizeThreadContext(context: ThreadContext): ThreadContext | null {
  const subject = String(context.subject || '').trim();
  const messageId = normalizeMessageId(context.messageId);
  if (!subject || !messageId) return null;
  return {
    subject,
    messageId,
    references: normalizeReferenceList(context.references),
  };
}

/**
 * Return *raw* as an RFC 5322 message id, or null when it is not one.
 *
 * Callers can hand a caller-supplied (and therefore arbitrary) string here
 * before it becomes an `In-Reply-To`/`References` header. Bare `left@right`
 * ids are accepted and wrapped, since that shape is common in hand-written
 * and model-written tool calls and still names a real message; anything else
 * — an internal id, a session key, prose — names nothing a mail client can
 * thread on and is rejected.
 */
export function normalizeThreadMessageId(
  raw: string | null | undefined,
): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const candidate = trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
  return MESSAGE_ID_RE.test(candidate) ? candidate : null;
}

export function hasReplySubjectPrefix(subject: string): boolean {
  return REPLY_SUBJECT_RE.test(String(subject || '').trim());
}

export function ensureReplySubject(subject: string): string {
  const trimmed = String(subject || '').trim() || DEFAULT_EMAIL_SUBJECT;
  return hasReplySubjectPrefix(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function createOutboundThreadContext(
  previous: ThreadContext | null,
  messageId: string,
  subject: string,
): ThreadContext | null {
  const normalizedMessageId = normalizeMessageId(messageId);
  const normalizedSubject = String(subject || '').trim();
  if (!normalizedMessageId || !normalizedSubject) return null;

  const references = normalizeReferenceList([
    ...(previous?.references || []),
    previous?.messageId || '',
  ]);
  return {
    subject: normalizedSubject,
    messageId: normalizedMessageId,
    references,
  };
}

export function createThreadTracker(): EmailThreadTracker {
  const contexts = new Map<string, ThreadContext>();

  return {
    get(sender: string): ThreadContext | null {
      const normalizedSender = normalizeEmailAddress(sender);
      if (!normalizedSender) return null;
      return contexts.get(normalizedSender) || null;
    },
    remember(sender: string, context: ThreadContext): void {
      const normalizedSender = normalizeEmailAddress(sender);
      const normalizedContext = normalizeThreadContext(context);
      if (!normalizedSender || !normalizedContext) return;
      contexts.set(normalizedSender, normalizedContext);
    },
    forget(sender: string): void {
      const normalizedSender = normalizeEmailAddress(sender);
      if (!normalizedSender) return;
      contexts.delete(normalizedSender);
    },
    clear(): void {
      contexts.clear();
    },
  };
}
