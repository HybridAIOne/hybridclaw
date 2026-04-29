import { randomUUID } from 'node:crypto';

import type { Config } from '@ngrok/ngrok';
import {
  recordAuditEvent as defaultRecordAuditEvent,
  type RecordAuditEventInput,
} from '../audit/audit-events.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import {
  DEFAULT_TUNNEL_HEALTH_CHECK_INTERVAL_MS as DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_TUNNEL_HEALTH_CHECK_TIMEOUT_MS as DEFAULT_HEALTH_TIMEOUT_MS,
  DEFAULT_TUNNEL_RECONNECT_INITIAL_BACKOFF_MS as DEFAULT_RECONNECT_INITIAL_BACKOFF_MS,
  DEFAULT_TUNNEL_RECONNECT_MAX_BACKOFF_MS as DEFAULT_RECONNECT_MAX_BACKOFF_MS,
  type TunnelProvider,
  type TunnelStartResult,
  type TunnelState,
  type TunnelStatus,
} from './tunnel-provider.js';

export const NGROK_AUTHTOKEN_SECRET = 'NGROK_AUTHTOKEN';
export const DEFAULT_NGROK_TUNNEL_ADDR = 9090;
const DEFAULT_NGROK_HEALTH_CHECK_PATH = '/health';
const RECONNECT_JITTER_RATIO = 0.1;
const TUNNEL_AUDIT_SESSION_ID = 'system:tunnel';

interface NgrokListener {
  url(): string | null;
  close(): Promise<void>;
}

interface NgrokClient {
  forward(config: Config | string | number): Promise<NgrokListener>;
}

type TunnelTimer = ReturnType<typeof setTimeout>;
type TunnelHealthFetch = (
  input: string | URL,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<Pick<Response, 'ok' | 'status'>>;
type TunnelAuditRecorder = (
  input: RecordAuditEventInput,
) => void | Promise<void>;
type TunnelStatusUpdate = {
  lastCheckedAt?: string | null;
  lastError?: string | null;
  nextReconnectAt?: string | null;
  reconnectAttempt?: number;
  state?: TunnelState;
};

export interface NgrokTunnelProviderOptions {
  addr?: Config['addr'];
  auditSessionId?: string;
  domain?: string;
  fetch?: TunnelHealthFetch;
  forwardsTo?: string;
  healthCheckIntervalMs?: number;
  healthCheckPath?: string;
  healthCheckTimeoutMs?: number;
  metadata?: string;
  onStatusChange?: (status: TunnelStatus) => void;
  readSecret?: (secretName: string) => string | null;
  reconnectInitialBackoffMs?: number;
  reconnectMaxBackoffMs?: number;
  recordAuditEvent?: TunnelAuditRecorder;
  schemes?: string[];
  tokenSecretName?: string;
  loadNgrok?: () => Promise<NgrokClient>;
}

async function loadDefaultNgrok(): Promise<NgrokClient> {
  return import('@ngrok/ngrok');
}

function normalizePublicUrl(value: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) {
    throw new Error('ngrok listener did not report a public URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`ngrok listener reported an invalid public URL: ${raw}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `ngrok listener reported a non-HTTP public URL: ${parsed.protocol}`,
    );
  }

  return parsed.toString().replace(/\/$/, '');
}

function redactSecret(message: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return message;
  return message.replaceAll(trimmed, '<redacted>');
}

function normalizeDurationMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function normalizeHealthCheckPath(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NGROK_HEALTH_CHECK_PATH;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_NGROK_HEALTH_CHECK_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function unrefTimer(timer: TunnelTimer): void {
  timer.unref();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTunnelAuditRunId(): string {
  return `tunnel_${randomUUID()}`;
}

function jitterReconnectDelayMs(delayMs: number): number {
  const factor =
    1 - RECONNECT_JITTER_RATIO + Math.random() * RECONNECT_JITTER_RATIO * 2;
  return Math.max(1, Math.round(delayMs * factor));
}

export class NgrokTunnelProvider implements TunnelProvider {
  private readonly addr: Config['addr'];
  private readonly auditSessionId: string;
  private readonly domain?: string;
  private readonly fetch: TunnelHealthFetch;
  private readonly forwardsTo?: string;
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckPath: string;
  private readonly healthCheckTimeoutMs: number;
  private readonly metadata?: string;
  private readonly onStatusChange?: (status: TunnelStatus) => void;
  private readonly readSecret: (secretName: string) => string | null;
  private readonly reconnectInitialBackoffMs: number;
  private readonly reconnectMaxBackoffMs: number;
  private readonly recordAuditEvent: TunnelAuditRecorder;
  private readonly schemes?: string[];
  private readonly tokenSecretName: string;
  private readonly loadNgrok: () => Promise<NgrokClient>;
  private healthTimer: TunnelTimer | null = null;
  private listener: NgrokListener | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private nextReconnectAt: string | null = null;
  private publicUrl: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: TunnelTimer | null = null;
  private state: TunnelState = 'down';
  private statusVersion = 0;
  private tunnelRunId: string | null = null;

  constructor(options: NgrokTunnelProviderOptions = {}) {
    this.addr = options.addr ?? DEFAULT_NGROK_TUNNEL_ADDR;
    this.auditSessionId =
      options.auditSessionId?.trim() || TUNNEL_AUDIT_SESSION_ID;
    this.domain = options.domain;
    this.fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.forwardsTo = options.forwardsTo;
    this.healthCheckIntervalMs = normalizeDurationMs(
      options.healthCheckIntervalMs,
      DEFAULT_HEALTH_INTERVAL_MS,
    );
    this.healthCheckPath = normalizeHealthCheckPath(options.healthCheckPath);
    this.healthCheckTimeoutMs = normalizeDurationMs(
      options.healthCheckTimeoutMs,
      DEFAULT_HEALTH_TIMEOUT_MS,
    );
    this.metadata = options.metadata;
    this.onStatusChange = options.onStatusChange;
    this.readSecret = options.readSecret ?? readStoredRuntimeSecret;
    this.reconnectInitialBackoffMs = normalizeDurationMs(
      options.reconnectInitialBackoffMs,
      DEFAULT_RECONNECT_INITIAL_BACKOFF_MS,
    );
    this.reconnectMaxBackoffMs = normalizeDurationMs(
      options.reconnectMaxBackoffMs,
      DEFAULT_RECONNECT_MAX_BACKOFF_MS,
    );
    if (this.reconnectInitialBackoffMs > this.reconnectMaxBackoffMs) {
      throw new Error(
        `reconnectInitialBackoffMs (${this.reconnectInitialBackoffMs}) must be less than or equal to reconnectMaxBackoffMs (${this.reconnectMaxBackoffMs}).`,
      );
    }
    this.recordAuditEvent = options.recordAuditEvent ?? defaultRecordAuditEvent;
    this.schemes = options.schemes;
    this.tokenSecretName =
      options.tokenSecretName?.trim() || NGROK_AUTHTOKEN_SECRET;
    this.loadNgrok = options.loadNgrok ?? loadDefaultNgrok;
  }

  async start(): Promise<TunnelStartResult> {
    if (this.listener && this.publicUrl) {
      return { public_url: this.publicUrl };
    }

    const startReason =
      this.state === 'reconnecting' ? 'manual_reconnect' : 'started';
    this.clearTimer('healthTimer');
    this.clearTimer('reconnectTimer');
    this.updateStatus({
      lastCheckedAt: null,
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'starting',
    });

    try {
      const { listener, publicUrl } = await this.openTunnel();
      await this.markTunnelUp(listener, publicUrl, startReason);
      this.scheduleHealthCheck();
      return { public_url: publicUrl };
    } catch (error) {
      const message = errorMessage(error);
      this.clearActiveTunnel({
        lastError: message,
        nextReconnectAt: null,
        reconnectAttempt: 0,
        state: 'down',
      });
      await this.recordTunnelAudit('tunnel.start_failed', {
        error: message,
        reason: startReason,
      });
      throw error;
    }
  }

  private async openTunnel(): Promise<{
    listener: NgrokListener;
    publicUrl: string;
  }> {
    const token = this.readSecret(this.tokenSecretName)?.trim() || '';
    if (!token) {
      throw new Error(
        `ngrok auth token is not configured in encrypted runtime secrets. Store it with \`hybridclaw secret set ${this.tokenSecretName} <token>\`.`,
      );
    }

    let listener: NgrokListener | null = null;
    try {
      const ngrok = await this.loadNgrok();
      const config: Config = {
        addr: this.addr,
        authtoken: token,
        proto: 'http',
      };
      if (this.domain) config.domain = this.domain;
      if (this.forwardsTo) config.forwards_to = this.forwardsTo;
      if (this.metadata) config.metadata = this.metadata;
      if (this.schemes) config.schemes = this.schemes;

      listener = await ngrok.forward(config);
      const publicUrl = normalizePublicUrl(listener.url());
      return { listener, publicUrl };
    } catch (error) {
      if (listener) {
        try {
          await listener.close();
        } catch {
          // Preserve the original start failure.
        }
      }
      throw new Error(
        `Failed to start ngrok tunnel: ${redactSecret(errorMessage(error), token)}`,
      );
    }
  }

  async stop(): Promise<void> {
    this.clearTimer('healthTimer');
    this.clearTimer('reconnectTimer');
    const { listener, publicUrl, tunnelRunId } = this.clearActiveTunnel({
      lastCheckedAt: null,
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'down',
    });
    if (publicUrl) {
      await this.recordTunnelAudit('tunnel.down', {
        publicUrl,
        reason: 'stopped',
        runId: tunnelRunId,
      });
    }
    if (listener) {
      await this.closeListener(listener);
    }
  }

  status(): TunnelStatus {
    return {
      running: Boolean(this.listener && this.publicUrl),
      public_url: this.publicUrl,
      state: this.state,
      last_error: this.lastError,
      last_checked_at: this.lastCheckedAt,
      next_reconnect_at: this.nextReconnectAt,
      reconnect_attempt: this.reconnectAttempt,
    };
  }

  private updateStatus(update: TunnelStatusUpdate): void {
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
      if (this.reconnectAttempt !== next) {
        this.reconnectAttempt = next;
        changed = true;
      }
    }
    if (update.state && this.state !== update.state) {
      this.state = update.state;
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
      this.onStatusChange(this.status());
    } catch (error) {
      console.warn(
        '[tunnel] status change handler failed.',
        errorMessage(error),
      );
    }
  }

  private async markTunnelUp(
    listener: NgrokListener,
    publicUrl: string,
    reason: string,
  ): Promise<void> {
    const wasRunning = Boolean(this.listener && this.publicUrl);
    const tunnelRunId = this.tunnelRunId ?? makeTunnelAuditRunId();
    this.listener = listener;
    this.publicUrl = publicUrl;
    this.tunnelRunId = tunnelRunId;
    this.updateStatus({
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'up',
    });
    if (!wasRunning) {
      await this.recordTunnelAudit('tunnel.up', {
        publicUrl,
        reason,
        runId: tunnelRunId,
      });
    }
  }

  private async markTunnelDown(params: {
    lastCheckedAt?: string;
    message: string;
    publicUrl: string;
    reason: string;
  }): Promise<void> {
    const { tunnelRunId } = this.clearActiveTunnel({
      lastCheckedAt: params.lastCheckedAt ?? null,
      lastError: params.message,
      state: 'reconnecting',
    });
    await this.recordTunnelAudit('tunnel.down', {
      error: params.message,
      publicUrl: params.publicUrl,
      reason: params.reason,
      runId: tunnelRunId,
    });
  }

  private async recordTunnelAudit(
    type: 'tunnel.up' | 'tunnel.down' | 'tunnel.start_failed',
    details: {
      error?: string;
      publicUrl?: string;
      reason: string;
      runId?: string | null;
    },
  ): Promise<void> {
    try {
      await this.recordAuditEvent({
        sessionId: this.auditSessionId,
        runId: details.runId ?? makeTunnelAuditRunId(),
        event: {
          type,
          provider: 'ngrok',
          reason: details.reason,
          ...(details.publicUrl ? { public_url: details.publicUrl } : {}),
          ...(details.error ? { error: details.error } : {}),
        },
      });
    } catch (error) {
      console.warn(
        '[tunnel] failed to record tunnel audit event.',
        errorMessage(error),
      );
    }
  }

  private clearActiveTunnel(update: TunnelStatusUpdate): {
    listener: NgrokListener | null;
    publicUrl: string | null;
    tunnelRunId: string | null;
  } {
    const listener = this.listener;
    const publicUrl = this.publicUrl;
    const tunnelRunId = this.tunnelRunId;
    this.listener = null;
    this.publicUrl = null;
    this.tunnelRunId = null;
    this.updateStatus(update);
    return { listener, publicUrl, tunnelRunId };
  }

  private clearTimer(name: 'healthTimer' | 'reconnectTimer'): void {
    const timer = this[name];
    if (!timer) return;
    clearTimeout(timer);
    this[name] = null;
  }

  private scheduleHealthCheck(): void {
    this.clearTimer('healthTimer');
    if (!this.listener || !this.publicUrl) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);
    unrefTimer(this.healthTimer);
  }

  private async runHealthCheck(): Promise<void> {
    const listener = this.listener;
    const publicUrl = this.publicUrl;
    if (!listener || !publicUrl || this.state !== 'up') return;

    const checkedAt = new Date().toISOString();
    try {
      await this.checkTunnelHealth(publicUrl);
      if (this.listener !== listener || this.publicUrl !== publicUrl) return;
      this.updateStatus({
        lastCheckedAt: checkedAt,
        lastError: null,
        reconnectAttempt: 0,
        state: 'up',
      });
      this.scheduleHealthCheck();
    } catch (error) {
      if (this.listener !== listener || this.publicUrl !== publicUrl) return;
      const message = errorMessage(error);
      await this.markTunnelDown({
        lastCheckedAt: checkedAt,
        message,
        publicUrl,
        reason: 'health_check_failed',
      });
      await this.closeListener(listener);
      this.scheduleReconnect(message);
    }
  }

  private async checkTunnelHealth(publicUrl: string): Promise<void> {
    const healthUrl = new URL(this.healthCheckPath, `${publicUrl}/`).toString();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.healthCheckTimeoutMs,
    );
    unrefTimer(timeout);
    try {
      const response = await this.fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`tunnel health check returned HTTP ${response.status}`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `tunnel health check timed out after ${this.healthCheckTimeoutMs}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private scheduleReconnect(message: string): void {
    const attempt = this.reconnectAttempt + 1;
    const baseDelayMs = Math.min(
      this.reconnectMaxBackoffMs,
      this.reconnectInitialBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    const delayMs = jitterReconnectDelayMs(baseDelayMs);
    const nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.updateStatus({
      lastError: message,
      nextReconnectAt,
      reconnectAttempt: attempt,
      state: 'reconnecting',
    });
    this.clearTimer('reconnectTimer');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delayMs);
    unrefTimer(this.reconnectTimer);
  }

  private async reconnect(): Promise<void> {
    if (this.state !== 'reconnecting' || this.listener || this.publicUrl)
      return;
    try {
      const { listener, publicUrl } = await this.openTunnel();
      await this.markTunnelUp(listener, publicUrl, 'reconnected');
      this.scheduleHealthCheck();
    } catch (error) {
      this.scheduleReconnect(errorMessage(error));
    }
  }

  private async closeListener(listener: NgrokListener): Promise<void> {
    try {
      await listener.close();
    } catch {
      console.warn(
        '[tunnel] failed to stop ngrok tunnel cleanly; local tunnel state was cleared.',
      );
    }
  }
}

export function createNgrokTunnelProvider(
  options: NgrokTunnelProviderOptions = {},
): TunnelProvider {
  return new NgrokTunnelProvider(options);
}
