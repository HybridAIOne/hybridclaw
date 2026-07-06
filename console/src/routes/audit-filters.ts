export const CATEGORIES = [
  'session',
  'turn',
  'onboarding',
  'model',
  'tool',
  'autonomy',
  'authorization',
  'approval',
  'a2a',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const KNOWN_CATEGORIES = new Set<string>(CATEGORIES);

export const TIME_RANGES = [
  { value: 'all', label: 'All' },
  { value: '1h', label: '1h' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
] as const;
export type TimeRange = (typeof TIME_RANGES)[number]['value'];

const TIME_RANGE_VALUES = new Set<string>(TIME_RANGES.map((r) => r.value));

const RANGE_TO_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Map an event type like `session.end` or `tool.call` to its known category
 * (the dot prefix) or 'default' when the prefix isn't one we colour.
 */
export function categorize(eventType: string): Category | 'default' {
  const prefix = eventType.split('.', 1)[0] ?? '';
  return KNOWN_CATEGORIES.has(prefix) ? (prefix as Category) : 'default';
}

/**
 * Convert a time-range pill into a `since` cutoff (ISO string) suitable for
 * the audit API's `since=` param. `'all'` returns undefined (no cutoff).
 */
export function rangeToSince(
  range: TimeRange,
  now: number = Date.now(),
): string | undefined {
  if (range === 'all') return undefined;
  return new Date(now - RANGE_TO_MS[range]).toISOString();
}

/** Validate a raw URL `range` param; fall back to 'all'. */
export function readRange(value: string | undefined): TimeRange {
  return value && TIME_RANGE_VALUES.has(value) ? (value as TimeRange) : 'all';
}
