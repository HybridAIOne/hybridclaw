import { normalizeEmailAddress } from './allowlist.js';
import { DEFAULT_EMAIL_SUBJECT } from './constants.js';

const REPLY_SUBJECT_RE = /^re(?:\[\d+\])?:\s*/i;

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
