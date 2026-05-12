import {
  makeAuditRunId,
  type RecordAuditEventInput,
} from '../audit/audit-events.js';
import type { TunnelState, TunnelStatus } from './tunnel-provider.js';

export const DEFAULT_TUNNEL_AUDIT_SESSION_ID = 'system:tunnel';

export type TunnelTimer = ReturnType<typeof setTimeout>;
export type TunnelAuditRecorder = (
  input: RecordAuditEventInput,
) => void | Promise<void>;
export type TunnelHealthFetch = (
  input: string | URL,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'status'>>;
export type TunnelStatusUpdate = {
  lastCheckedAt?: string | null;
  lastError?: string | null;
  nextReconnectAt?: string | null;
  reconnectAttempt?: number;
  state?: TunnelState;
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function redactSecret(message: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return message;
  return message.replaceAll(trimmed, '<redacted>');
}

export function normalizeDurationMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

export function normalizeHealthCheckPath(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function unrefTimer(timer: TunnelTimer): void {
  timer.unref();
}

export function makeTunnelRunId(): string {
  return makeAuditRunId('tunnel');
}

export class TunnelStatusTracker {
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private nextReconnectAt: string | null = null;
  private reconnectAttemptValue = 0;
  private stateValue: TunnelState = 'down';
  private statusVersion = 0;

  constructor(
    private readonly getStatus: () => TunnelStatus,
    private readonly onStatusChange?: (status: TunnelStatus) => void,
  ) {}

  get state(): TunnelState {
    return this.stateValue;
  }

  get reconnectAttempt(): number {
    return this.reconnectAttemptValue;
  }

  snapshot(running: boolean, publicUrl: string | null): TunnelStatus {
    return {
      running,
      public_url: publicUrl,
      state: this.stateValue,
      last_error: this.lastError,
      last_checked_at: this.lastCheckedAt,
      next_reconnect_at: this.nextReconnectAt,
      reconnect_attempt: this.reconnectAttemptValue,
    };
  }

  update(update: TunnelStatusUpdate): void {
    const previousVersion = this.statusVersion;
    let changed = false;
    if ('lastCheckedAt' in update) {
      const next = update.lastCheckedAt ?? null;
      if (this.lastCheckedAt !== next) {
        this.lastCheckedAt = next;
        changed = true;
      }
    }
    if ('lastError' in update) {
      const next = update.lastError ?? null;
      if (this.lastError !== next) {
        this.lastError = next;
        changed = true;
      }
    }
    if ('nextReconnectAt' in update) {
      const next = update.nextReconnectAt ?? null;
      if (this.nextReconnectAt !== next) {
        this.nextReconnectAt = next;
        changed = true;
      }
    }
    if ('reconnectAttempt' in update) {
      const next = Math.max(0, update.reconnectAttempt ?? 0);
      if (this.reconnectAttemptValue !== next) {
        this.reconnectAttemptValue = next;
        changed = true;
      }
    }
    if (update.state && this.stateValue !== update.state) {
      this.stateValue = update.state;
      changed = true;
    }

    if (changed) {
      this.statusVersion += 1;
    }
    if (this.statusVersion !== previousVersion) {
      this.publishStatusChange();
    }
  }

  private publishStatusChange(): void {
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(this.getStatus());
    } catch (error) {
      console.warn(
        '[tunnel] status change handler failed.',
        errorMessage(error),
      );
    }
  }
}

export async function recordTunnelAudit(params: {
  auditSessionId: string;
  details: {
    error?: string;
    publicUrl?: string;
    reason: string;
    runId?: string | null;
  };
  provider: string;
  recordAuditEvent: TunnelAuditRecorder;
  type: 'tunnel.up' | 'tunnel.down' | 'tunnel.start_failed';
}): Promise<void> {
  try {
    await params.recordAuditEvent({
      sessionId: params.auditSessionId,
      runId: params.details.runId ?? makeTunnelRunId(),
      event: {
        type: params.type,
        provider: params.provider,
        reason: params.details.reason,
        ...(params.details.publicUrl
          ? { public_url: params.details.publicUrl }
          : {}),
        ...(params.details.error ? { error: params.details.error } : {}),
      },
    });
  } catch (error) {
    console.warn(
      '[tunnel] failed to record tunnel audit event.',
      errorMessage(error),
    );
  }
}
