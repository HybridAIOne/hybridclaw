export function parseTimestamp(raw: string | null | undefined): Date | null {
  const value = (raw || '').trim();
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(`${value.replace(' ', 'T')}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseTimestampMs(raw: string | null | undefined): number {
  return parseTimestamp(raw)?.getTime() ?? 0;
}

export function formatRelativeTimeFromMs(
  timestampMs: number | null | undefined,
): string {
  if (
    timestampMs == null ||
    !Number.isFinite(timestampMs) ||
    timestampMs <= 0
  ) {
    return 'unknown';
  }
  const deltaMs = Date.now() - timestampMs;
  if (deltaMs < 15_000) return 'just now';
  if (deltaMs < 60_000) {
    return `${Math.max(1, Math.floor(deltaMs / 1_000))}s ago`;
  }
  if (deltaMs < 3_600_000) {
    return `${Math.max(1, Math.floor(deltaMs / 60_000))}m ago`;
  }
  if (deltaMs < 86_400_000) {
    return `${Math.max(1, Math.floor(deltaMs / 3_600_000))}h ago`;
  }
  return `${Math.max(1, Math.floor(deltaMs / 86_400_000))}d ago`;
}

export function formatRelativeTime(raw: string | null | undefined): string {
  return formatRelativeTimeFromMs(parseTimestamp(raw)?.getTime() ?? null);
}

export function formatDisplayTimestamp(raw: string | null | undefined): string {
  const date = parseTimestamp(raw);
  if (!date) return 'unknown';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = new Map(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value] as const),
  );

  const month = values.get('month') || 'Unknown';
  const day = values.get('day') || '0';
  const year = values.get('year') || '0000';
  const hour = values.get('hour') || '00';
  const minute = values.get('minute') || '00';
  return `${month} ${day}, ${year}, ${hour}:${minute}`;
}
