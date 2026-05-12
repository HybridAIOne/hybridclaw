const SIGNAL_PREFIX_RE = /^signal:/i;
const SIGNAL_PHONE_RE = /^\+\d{6,15}$/;
const SIGNAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNAL_GROUP_RE = /^group:[A-Za-z0-9+/=_-]{8,}$/;

export type SignalRecipientKind = 'phone' | 'uuid' | 'group';

export interface ParsedSignalTarget {
  kind: SignalRecipientKind;
  recipient: string;
}

function classifyRecipient(value: string): SignalRecipientKind | null {
  if (SIGNAL_GROUP_RE.test(value)) return 'group';
  if (SIGNAL_PHONE_RE.test(value)) return 'phone';
  if (SIGNAL_UUID_RE.test(value)) return 'uuid';
  return null;
}

export function normalizeSignalRecipient(value: string): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  const stripped = trimmed.replace(SIGNAL_PREFIX_RE, '').trim();
  if (!stripped) return undefined;
  if (SIGNAL_GROUP_RE.test(stripped)) return stripped;
  if (SIGNAL_PHONE_RE.test(stripped)) return stripped;
  if (SIGNAL_UUID_RE.test(stripped)) return stripped.toLowerCase();
  return undefined;
}

export function parseSignalTarget(value: string): ParsedSignalTarget | null {
  const recipient = normalizeSignalRecipient(value);
  if (!recipient) return null;
  const kind = classifyRecipient(recipient);
  if (!kind) return null;
  return { kind, recipient };
}

export function buildSignalChannelId(recipient: string): string {
  const normalized = normalizeSignalRecipient(recipient);
  if (!normalized) {
    throw new Error(`Invalid Signal recipient: ${recipient}`);
  }
  return `signal:${normalized}`;
}

export function normalizeSignalChannelId(value: string): string | undefined {
  const parsed = parseSignalTarget(value);
  if (!parsed) return undefined;
  return buildSignalChannelId(parsed.recipient);
}

export function isSignalChannelId(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed || !SIGNAL_PREFIX_RE.test(trimmed)) return false;
  return Boolean(parseSignalTarget(trimmed));
}

export function resolveSignalTargetChatType(
  value: string,
): 'direct' | 'group' | 'unknown' {
  const parsed = parseSignalTarget(value);
  if (!parsed) return 'unknown';
  return parsed.kind === 'group' ? 'group' : 'direct';
}
