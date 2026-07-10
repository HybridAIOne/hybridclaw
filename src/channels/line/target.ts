const LINE_PREFIX_RE = /^line:/i;
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/i;
const LINE_GROUP_ID_RE = /^C[0-9a-f]{32}$/i;
const LINE_ROOM_ID_RE = /^R[0-9a-f]{32}$/i;

export type LineRecipientKind = 'user' | 'group' | 'room';

export interface ParsedLineTarget {
  kind: LineRecipientKind;
  recipient: string;
}

function normalizeLinePlatformId(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (LINE_USER_ID_RE.test(trimmed)) return trimmed;
  if (LINE_GROUP_ID_RE.test(trimmed)) return trimmed;
  if (LINE_ROOM_ID_RE.test(trimmed)) return trimmed;
  return null;
}

function inferLineRecipientKind(value: string): LineRecipientKind | null {
  if (LINE_USER_ID_RE.test(value)) return 'user';
  if (LINE_GROUP_ID_RE.test(value)) return 'group';
  if (LINE_ROOM_ID_RE.test(value)) return 'room';
  return null;
}

export function normalizeLineUserId(value: string): string | undefined {
  const normalized = normalizeLinePlatformId(value);
  return normalized && LINE_USER_ID_RE.test(normalized)
    ? normalized
    : undefined;
}

export function parseLineTarget(value: string): ParsedLineTarget | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const withoutPrefix = trimmed.replace(LINE_PREFIX_RE, '').trim();
  if (!withoutPrefix) return null;

  const parts = withoutPrefix.split(':');
  if (parts.length === 1) {
    const recipient = normalizeLinePlatformId(parts[0] || '');
    const kind = recipient ? inferLineRecipientKind(recipient) : null;
    return recipient && kind ? { kind, recipient } : null;
  }

  if (parts.length !== 2) return null;
  const kindValue = String(parts[0] || '')
    .trim()
    .toLowerCase();
  const recipient = normalizeLinePlatformId(parts[1] || '');
  if (!recipient) return null;
  if (kindValue === 'user' && LINE_USER_ID_RE.test(recipient)) {
    return { kind: 'user', recipient };
  }
  if (kindValue === 'group' && LINE_GROUP_ID_RE.test(recipient)) {
    return { kind: 'group', recipient };
  }
  if (kindValue === 'room' && LINE_ROOM_ID_RE.test(recipient)) {
    return { kind: 'room', recipient };
  }
  return null;
}

export function buildLineChannelId(
  recipient: string,
  kind?: LineRecipientKind,
): string {
  const normalized = normalizeLinePlatformId(recipient);
  const inferredKind = normalized ? inferLineRecipientKind(normalized) : null;
  const resolvedKind = kind || inferredKind;
  if (!normalized || !resolvedKind || resolvedKind !== inferredKind) {
    throw new Error(`Invalid LINE recipient: ${recipient}`);
  }
  if (resolvedKind === 'user') return `line:${normalized}`;
  return `line:${resolvedKind}:${normalized}`;
}

export function normalizeLineChannelId(value: string): string | undefined {
  const parsed = parseLineTarget(value);
  if (!parsed) return undefined;
  return buildLineChannelId(parsed.recipient, parsed.kind);
}

export function normalizeLineSendTargetId(value: string): string | undefined {
  const trimmed = String(value || '').trim();
  if (!trimmed || !LINE_PREFIX_RE.test(trimmed)) return undefined;
  return normalizeLineChannelId(trimmed);
}

export function isLineChannelId(value: string): boolean {
  const trimmed = String(value || '').trim();
  if (!trimmed || !LINE_PREFIX_RE.test(trimmed)) return false;
  return Boolean(parseLineTarget(trimmed));
}
