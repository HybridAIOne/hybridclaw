import {
  PROACTIVE_ACTIVE_HOURS_ENABLED,
  PROACTIVE_ACTIVE_HOURS_END,
  PROACTIVE_ACTIVE_HOURS_START,
  PROACTIVE_ACTIVE_HOURS_TIMEZONE,
} from './config.js';

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

export function isWithinActiveHours(now = new Date()): boolean {
  if (!PROACTIVE_ACTIVE_HOURS_ENABLED) return true;

  const start = Math.max(0, Math.min(23, PROACTIVE_ACTIVE_HOURS_START));
  const end = Math.max(0, Math.min(23, PROACTIVE_ACTIVE_HOURS_END));
  if (start === end) return true;

  const hour = resolveHourInTimezone(now, PROACTIVE_ACTIVE_HOURS_TIMEZONE) ?? now.getHours();

  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

export function proactiveWindowLabel(): string {
  if (!PROACTIVE_ACTIVE_HOURS_ENABLED) return 'always-on';
  const zone = PROACTIVE_ACTIVE_HOURS_TIMEZONE || 'local';
  return `${String(PROACTIVE_ACTIVE_HOURS_START).padStart(2, '0')}:00-${String(PROACTIVE_ACTIVE_HOURS_END).padStart(2, '0')}:00 (${zone})`;
}
