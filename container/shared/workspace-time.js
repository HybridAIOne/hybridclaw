export function extractUserTimezone(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined;
  const match = content.match(/\*\*Timezone:\*\*\s*(.+)/i);
  const timezone = match?.[1]?.trim();
  return timezone || undefined;
}

export function currentDateStampInTimezone(timezone, now = new Date()) {
  const resolvedTimezone =
    timezone?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC';

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: resolvedTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // fall through
  }

  return now.toISOString().slice(0, 10);
}

export function nextDateBoundaryInTimezone(timezone, now = new Date()) {
  const currentStamp = currentDateStampInTimezone(timezone, now);
  let low = now.getTime();
  let high = low + 60 * 60 * 1000;

  while (
    currentDateStampInTimezone(timezone, new Date(high)) === currentStamp
  ) {
    high += 60 * 60 * 1000;
  }

  while (high - low > 1) {
    const midpoint = Math.floor((low + high) / 2);
    if (
      currentDateStampInTimezone(timezone, new Date(midpoint)) === currentStamp
    ) {
      low = midpoint;
    } else {
      high = midpoint;
    }
  }

  return new Date(high);
}
