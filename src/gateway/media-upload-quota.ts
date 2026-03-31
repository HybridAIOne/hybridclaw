export interface MediaUploadQuotaDecision {
  allowed: boolean;
  remainingBytes: number;
  retryAfterMs: number;
  usedBytes: number;
}

interface MediaUploadQuotaEntry {
  bytes: number;
  timestampMs: number;
}

export class SlidingWindowByteQuota {
  private readonly buckets = new Map<string, MediaUploadQuotaEntry[]>();

  constructor(private readonly windowMs = 5 * 60 * 1_000) {}

  consume(
    key: string,
    bytes: number,
    limitBytes: number,
    nowMs = Date.now(),
  ): MediaUploadQuotaDecision {
    const boundedBytes = Math.max(0, Math.floor(bytes));
    const boundedLimitBytes = Math.max(0, Math.floor(limitBytes));
    if (!key || boundedBytes <= 0 || boundedLimitBytes <= 0) {
      return {
        allowed: true,
        remainingBytes: Number.POSITIVE_INFINITY,
        retryAfterMs: 0,
        usedBytes: 0,
      };
    }

    const cutoff = nowMs - this.windowMs;
    const activeEntries = (this.buckets.get(key) ?? []).filter(
      (entry) => entry.timestampMs > cutoff,
    );
    const usedBytes = activeEntries.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
    const projectedBytes = usedBytes + boundedBytes;

    if (projectedBytes > boundedLimitBytes) {
      const requiredExpiredBytes = projectedBytes - boundedLimitBytes;
      let reclaimedBytes = 0;
      let retryAfterMs = this.windowMs;
      for (const entry of activeEntries) {
        reclaimedBytes += entry.bytes;
        retryAfterMs = Math.max(0, entry.timestampMs + this.windowMs - nowMs);
        if (reclaimedBytes >= requiredExpiredBytes) {
          break;
        }
      }
      this.buckets.set(key, activeEntries);
      return {
        allowed: false,
        remainingBytes: Math.max(0, boundedLimitBytes - usedBytes),
        retryAfterMs,
        usedBytes,
      };
    }

    activeEntries.push({ bytes: boundedBytes, timestampMs: nowMs });
    this.buckets.set(key, activeEntries);
    return {
      allowed: true,
      remainingBytes: Math.max(0, boundedLimitBytes - projectedBytes),
      retryAfterMs: 0,
      usedBytes: projectedBytes,
    };
  }
}

export const GATEWAY_MEDIA_UPLOAD_QUOTA_WINDOW_MS = 5 * 60 * 1_000;
export const GATEWAY_MEDIA_UPLOAD_QUOTA_MAX_BYTES = 100 * 1024 * 1024;

const gatewayMediaUploadQuota = new SlidingWindowByteQuota(
  GATEWAY_MEDIA_UPLOAD_QUOTA_WINDOW_MS,
);

export function consumeGatewayMediaUploadQuota(params: {
  key: string;
  bytes: number;
  nowMs?: number;
  limitBytes?: number;
}): MediaUploadQuotaDecision {
  return gatewayMediaUploadQuota.consume(
    params.key,
    params.bytes,
    params.limitBytes ?? GATEWAY_MEDIA_UPLOAD_QUOTA_MAX_BYTES,
    params.nowMs,
  );
}
