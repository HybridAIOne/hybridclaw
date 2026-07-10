const LINE_PREFIX_RE = /^line:/i;
const LINE_USER_MID_RE = /^u[0-9a-f]{32}$/i;

export function normalizeLineUserMid(value: string): string | null {
  const normalized = String(value || '')
    .trim()
    .replace(LINE_PREFIX_RE, '')
    .trim()
    .toLowerCase();
  return LINE_USER_MID_RE.test(normalized) ? normalized : null;
}

export function buildLineChannelId(mid: string): string {
  const normalized = normalizeLineUserMid(mid);
  if (!normalized) throw new Error(`Invalid LINE user MID: ${mid}`);
  return `line:${normalized}`;
}

export function normalizeLineChannelId(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!LINE_PREFIX_RE.test(trimmed)) return null;
  const mid = normalizeLineUserMid(trimmed);
  return mid ? buildLineChannelId(mid) : null;
}

export function isLineChannelId(value: string): boolean {
  return normalizeLineChannelId(value) !== null;
}
