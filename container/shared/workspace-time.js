import fs from 'node:fs';

function resolveTimezone(timezone) {
  return (
    timezone?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

function getDatePartsInTimezone(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return {
    year: parts.find((part) => part.type === 'year')?.value || '',
    month: parts.find((part) => part.type === 'month')?.value || '',
    day: parts.find((part) => part.type === 'day')?.value || '',
    hour: parts.find((part) => part.type === 'hour')?.value || '',
    minute: parts.find((part) => part.type === 'minute')?.value || '',
    second: parts.find((part) => part.type === 'second')?.value || '',
  };
}

function getTimezoneOffsetMs(timezone, date) {
  const parts = getDatePartsInTimezone(timezone, date);
  const utcTimestamp = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return utcTimestamp - date.getTime();
}

export function extractUserTimezone(content) {
  if (typeof content !== 'string' || !content.trim()) return undefined;
  const match = content.match(/\*\*Timezone:\*\*\s*(.+)/i);
  const timezone = match?.[1]?.trim();
  return timezone || undefined;
}

export function readUserTimezoneFile(userPath) {
  try {
    if (!fs.existsSync(userPath)) return undefined;
    return extractUserTimezone(fs.readFileSync(userPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

export function currentDateStampInTimezone(timezone, now = new Date()) {
  const resolvedTimezone = resolveTimezone(timezone);

  try {
    const { year, month, day } = getDatePartsInTimezone(resolvedTimezone, now);
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // fall through
  }

  return now.toISOString().slice(0, 10);
}

export function nextDateBoundaryInTimezone(timezone, now = new Date()) {
  const resolvedTimezone = resolveTimezone(timezone);
  const current = getDatePartsInTimezone(resolvedTimezone, now);
  const tomorrow = new Date(
    Date.UTC(
      Number(current.year),
      Number(current.month) - 1,
      Number(current.day) + 1,
    ),
  );
  const localMidnightAsUtc = Date.UTC(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth(),
    tomorrow.getUTCDate(),
    0,
    0,
    0,
  );
  const initialGuess = new Date(localMidnightAsUtc);
  const offsetAtGuess = getTimezoneOffsetMs(resolvedTimezone, initialGuess);
  const candidate = new Date(localMidnightAsUtc - offsetAtGuess);
  const refinedOffset = getTimezoneOffsetMs(resolvedTimezone, candidate);
  return new Date(localMidnightAsUtc - refinedOffset);
}
