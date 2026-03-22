export const CONTEXT_GUARD_DEFAULTS = Object.freeze({
  enabled: true,
  perResultShare: 0.3,
  compactionRatio: 0.75,
  overflowRatio: 0.75,
  maxRetries: 3,
});

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function readNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readInteger(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeContextGuardConfig(value, fallback) {
  const base = isRecord(fallback) ? fallback : CONTEXT_GUARD_DEFAULTS;
  const raw = isRecord(value) ? value : {};

  const perResultShare = clamp(
    readNumber(raw.perResultShare, base.perResultShare),
    0.1,
    0.9,
  );
  const compactionRatio = clamp(
    readNumber(raw.compactionRatio, base.compactionRatio),
    0.2,
    0.98,
  );
  const overflowRatio = Math.max(
    compactionRatio,
    clamp(readNumber(raw.overflowRatio, base.overflowRatio), 0.3, 0.99),
  );

  return {
    enabled: readBoolean(raw.enabled, base.enabled),
    perResultShare,
    compactionRatio,
    overflowRatio,
    maxRetries: clamp(readInteger(raw.maxRetries, base.maxRetries), 0, 10),
  };
}
