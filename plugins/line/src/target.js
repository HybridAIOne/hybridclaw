/**
 * LINE channel ids are `line:<user mid>`; the channel only ever addresses the
 * linked account's own self-chat.
 */
const LINE_PREFIX_RE = /^line:/i;
const LINE_USER_MID_RE = /^u[0-9a-f]{32}$/i;

/** @param {string} value */
export function normalizeLineUserMid(value) {
  const normalized = String(value || '')
    .trim()
    .replace(LINE_PREFIX_RE, '')
    .trim()
    .toLowerCase();
  return LINE_USER_MID_RE.test(normalized) ? normalized : null;
}

/** @param {string} mid */
export function buildLineChannelId(mid) {
  const normalized = normalizeLineUserMid(mid);
  if (!normalized) throw new Error(`Invalid LINE user MID: ${mid}`);
  return `line:${normalized}`;
}

/** @param {string} value */
export function normalizeLineChannelId(value) {
  const trimmed = String(value || '').trim();
  if (!LINE_PREFIX_RE.test(trimmed)) return null;
  const mid = normalizeLineUserMid(trimmed);
  return mid ? buildLineChannelId(mid) : null;
}

/** @param {string} value */
export function isLineChannelId(value) {
  return normalizeLineChannelId(value) !== null;
}

/**
 * Message-tool target resolution: null for targets that are not LINE's, an
 * error for `line:` targets that are malformed.
 *
 * @param {string} value
 */
export function normalizeLineMessageTarget(value) {
  const trimmed = String(value || '').trim();
  if (!LINE_PREFIX_RE.test(trimmed)) return null;
  const channelId = normalizeLineChannelId(trimmed);
  if (!channelId) {
    throw new Error('LINE send targets must use `line:<linked-user-mid>`.');
  }
  return channelId;
}
