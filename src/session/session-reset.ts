import type { RuntimeConfig } from '../config/runtime-config.js';

export type SessionResetMode = 'daily' | 'idle' | 'both' | 'none';

export interface SessionResetPolicy {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes: number;
}

export const DEFAULT_RESET_POLICY: SessionResetPolicy = Object.freeze({
  mode: 'both',
  atHour: 4,
  idleMinutes: 1440,
});

export function normalizeSessionResetMode(
  value: unknown,
  fallback: SessionResetMode,
): SessionResetMode {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === 'daily' ||
      normalized === 'idle' ||
      normalized === 'both' ||
      normalized === 'none'
    ) {
      return normalized;
    }
  }
  if (
    value === 'daily' ||
    value === 'idle' ||
    value === 'both' ||
    value === 'none'
  ) {
    return value;
  }
  return fallback;
}

function normalizePolicy(
  value?: Partial<SessionResetPolicy>,
): SessionResetPolicy {
  const atHour = Number.isFinite(value?.atHour)
    ? Math.max(0, Math.min(23, Math.trunc(value?.atHour ?? 0)))
    : DEFAULT_RESET_POLICY.atHour;
  const idleMinutes = Number.isFinite(value?.idleMinutes)
    ? Math.max(1, Math.trunc(value?.idleMinutes ?? 0))
    : DEFAULT_RESET_POLICY.idleMinutes;
  return {
    mode: normalizeSessionResetMode(value?.mode, DEFAULT_RESET_POLICY.mode),
    atHour,
    idleMinutes,
  };
}

function parseSessionTimestamp(value: string): Date {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Session timestamp is empty');
  }

  const sqliteMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
  );
  if (sqliteMatch) {
    const [, year, month, day, hour, minute, second, millis] = sqliteMatch;
    return new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number((millis || '').padEnd(3, '0') || 0),
      ),
    );
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid session timestamp: ${value}`);
  }
  return parsed;
}

function getMostRecentResetBoundary(now: Date, atHour: number): Date {
  const boundary = new Date(now);
  boundary.setHours(atHour, 0, 0, 0);
  if (now.getHours() < atHour) {
    boundary.setDate(boundary.getDate() - 1);
  }
  return boundary;
}

export function isSessionExpired(
  policy: SessionResetPolicy,
  lastActive: string,
  now = new Date(),
): boolean {
  if (policy.mode === 'none') return false;

  const normalizedPolicy = normalizePolicy(policy);
  const lastActiveAt = parseSessionTimestamp(lastActive);

  if (normalizedPolicy.mode === 'idle' || normalizedPolicy.mode === 'both') {
    const idleMs = normalizedPolicy.idleMinutes * 60_000;
    if (now.getTime() - lastActiveAt.getTime() >= idleMs) {
      return true;
    }
  }

  if (normalizedPolicy.mode === 'daily' || normalizedPolicy.mode === 'both') {
    const resetBoundary = getMostRecentResetBoundary(
      now,
      normalizedPolicy.atHour,
    );
    if (lastActiveAt < resetBoundary) {
      return true;
    }
  }

  return false;
}

export function resolveResetPolicy(opts?: {
  channelKind?: string;
  config?: RuntimeConfig;
}): SessionResetPolicy {
  const config = opts?.config;
  if (!config) {
    return DEFAULT_RESET_POLICY;
  }

  const defaultPolicy = normalizePolicy(config.sessionReset.defaultPolicy);
  const override = opts?.channelKind
    ? config.sessionReset.byChannelKind?.[opts.channelKind]
    : undefined;
  if (!override) {
    return defaultPolicy;
  }
  return normalizePolicy({
    ...defaultPolicy,
    ...override,
  });
}
