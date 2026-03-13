const EMAIL_ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+$/;

function normalizeEmailDomain(raw: string): string | null {
  const trimmed = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!trimmed || trimmed.includes('@') || /\s/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function normalizeEmailAllowEntry(raw: string): string | null {
  const trimmed = String(raw || '')
    .trim()
    .toLowerCase();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  if (trimmed.startsWith('*@')) {
    const domain = normalizeEmailDomain(trimmed.slice(2));
    return domain ? `*@${domain}` : null;
  }
  return normalizeEmailAddress(trimmed);
}

export function normalizeEmailAddress(raw: string): string | null {
  const trimmed = String(raw || '')
    .trim()
    .toLowerCase();
  if (!trimmed) return null;

  const candidate = trimmed
    .replace(/^mailto:/, '')
    .replace(/^.*<([^>]+)>.*$/, '$1')
    .trim();
  if (!candidate || !EMAIL_ADDRESS_RE.test(candidate)) {
    return null;
  }
  return candidate;
}

export function isEmailAddress(raw: string): boolean {
  return normalizeEmailAddress(raw) !== null;
}

export function matchesEmailAllowList(
  allowList: string[],
  sender: string,
): boolean {
  if (allowList.length === 0) return false;

  const normalizedSender = normalizeEmailAddress(sender);
  if (!normalizedSender) return false;

  const atIndex = normalizedSender.lastIndexOf('@');
  const senderDomain =
    atIndex === -1 ? '' : normalizedSender.slice(atIndex + 1).toLowerCase();

  for (const entry of allowList) {
    const normalizedEntry = normalizeEmailAllowEntry(entry);
    if (!normalizedEntry) continue;
    if (normalizedEntry === '*') return true;
    if (normalizedEntry === normalizedSender) return true;
    if (
      normalizedEntry.startsWith('*@') &&
      senderDomain === normalizedEntry.slice(2)
    ) {
      return true;
    }
  }

  return false;
}
