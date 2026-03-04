export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly notifyAt = new Map<string, number>();

  constructor(windowMs = 60_000) {
    this.windowMs = Math.max(1_000, Math.floor(windowMs));
  }

  check(key: string, limit: number, nowMs = Date.now()): RateLimitDecision {
    const boundedLimit = Math.max(0, Math.floor(limit));
    if (!key || boundedLimit === 0) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
      };
    }

    const cutoff = nowMs - this.windowMs;
    const timestamps = this.buckets.get(key) ?? [];
    const active = timestamps.filter((ts) => ts > cutoff);

    if (active.length >= boundedLimit) {
      this.buckets.set(key, active);
      const oldest = active[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - nowMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs,
      };
    }

    active.push(nowMs);
    this.buckets.set(key, active);
    return {
      allowed: true,
      remaining: Math.max(0, boundedLimit - active.length),
      retryAfterMs: 0,
    };
  }

  shouldNotify(key: string, cooldownMs = 10_000, nowMs = Date.now()): boolean {
    if (!key) return true;
    const boundedCooldown = Math.max(1_000, Math.floor(cooldownMs));
    const nextAllowedAt = this.notifyAt.get(key) ?? 0;
    if (nowMs < nextAllowedAt) return false;
    this.notifyAt.set(key, nowMs + boundedCooldown);
    return true;
  }
}
