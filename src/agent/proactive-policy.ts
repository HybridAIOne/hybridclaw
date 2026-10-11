import {
  PROACTIVE_ACTIVE_HOURS_ENABLED,
  PROACTIVE_ACTIVE_HOURS_END,
  PROACTIVE_ACTIVE_HOURS_START,
  PROACTIVE_ACTIVE_HOURS_TIMEZONE,
} from '../config/config.js';

function resolveHourInTimezone(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hour12: false,
      timeZone: timezone || undefined,
    }).formatToParts(now);
    const hourRaw = parts.find((part) => part.type === 'hour')?.value;
    if (!hourRaw) return null;
    const hour = Number.parseInt(hourRaw, 10);
    if (!Number.isFinite(hour)) return null;
    return hour;
  } catch {
    return null;
  }
}

/**
 * Whether `now` falls in the configured active hours, read in `timezone`
 * (the user's, where a caller knows it) or else the configured zone.
 */
export function isWithinActiveHours(
  now = new Date(),
  timezone?: string | null,
): boolean {
  if (!PROACTIVE_ACTIVE_HOURS_ENABLED) return true;

  const start = Math.max(0, Math.min(23, PROACTIVE_ACTIVE_HOURS_START));
  const end = Math.max(0, Math.min(23, PROACTIVE_ACTIVE_HOURS_END));
  if (start === end) return true;

  const hour =
    (timezone ? resolveHourInTimezone(now, timezone) : null) ??
    resolveHourInTimezone(now, PROACTIVE_ACTIVE_HOURS_TIMEZONE) ??
    now.getHours();

  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

// 08:00–22:00 (product owner, 2026-10-10): the apps promise that Hy never
// calls on its own at night, so an unasked call keeps to this window where
// proactive active hours are off. Per-user call hours deferred.
const CALL_HOURS_START = 8;
const CALL_HOURS_END = 22;

/**
 * Whether Hy may call the user unasked at `now`: within the proactive active
 * hours when they are on, else within 08:00–22:00. Read in `timezone` (the
 * user's, where known), else the configured zone or the gateway's own.
 */
export function isWithinCallHours(
  now = new Date(),
  timezone?: string | null,
): boolean {
  if (PROACTIVE_ACTIVE_HOURS_ENABLED) return isWithinActiveHours(now, timezone);
  const hour =
    (timezone ? resolveHourInTimezone(now, timezone) : null) ?? now.getHours();
  return hour >= CALL_HOURS_START && hour < CALL_HOURS_END;
}

export function proactiveWindowLabel(): string {
  if (!PROACTIVE_ACTIVE_HOURS_ENABLED) return 'always-on';
  const zone = PROACTIVE_ACTIVE_HOURS_TIMEZONE || 'local';
  return `${String(PROACTIVE_ACTIVE_HOURS_START).padStart(2, '0')}:00-${String(PROACTIVE_ACTIVE_HOURS_END).padStart(2, '0')}:00 (${zone})`;
}
