import { execFile } from 'node:child_process';
import { recordAuditEvent as defaultRecordAuditEvent } from '../audit/audit-events.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import {
  DEFAULT_TUNNEL_HEALTH_CHECK_TIMEOUT_MS as DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_TUNNEL_HEALTH_CHECK_INTERVAL_MS as DEFAULT_HEALTH_INTERVAL_MS,
  DEFAULT_TUNNEL_RECONNECT_INITIAL_BACKOFF_MS as DEFAULT_RECONNECT_INITIAL_BACKOFF_MS,
  DEFAULT_TUNNEL_RECONNECT_MAX_BACKOFF_MS as DEFAULT_RECONNECT_MAX_BACKOFF_MS,
  type TunnelProvider,
  type TunnelStartResult,
  type TunnelStatus,
} from './tunnel-provider.js';
import {
  DEFAULT_TUNNEL_AUDIT_SESSION_ID,
  errorMessage,
  makeTunnelRunId,
  normalizeDurationMs,
  recordTunnelAudit,
  redactSecret,
  type TunnelAuditRecorder,
  TunnelStatusTracker,
  type TunnelStatusUpdate,
  type TunnelTimer,
} from './tunnel-provider-utils.js';

export const TS_AUTHKEY_SECRET = 'TS_AUTHKEY';
export const DEFAULT_TAILSCALE_TUNNEL_ADDR = 'localhost:9090';

type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};
type TailscaleCommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};
type TailscaleCommandRunner = (
  args: string[],
  options?: TailscaleCommandOptions,
) => Promise<TailscaleCommandResult>;

export interface TailscaleTunnelProviderOptions {
  addr?: string;
  commandTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  onStatusChange?: (status: TunnelStatus) => void;
  readSecret?: (secretName: string) => string | null;
  reconnectInitialBackoffMs?: number;
  reconnectMaxBackoffMs?: number;
  recordAuditEvent?: TunnelAuditRecorder;
  runCommand?: TailscaleCommandRunner;
  tailscaleCommand?: string;
  tokenSecretName?: string;
}

function runTailscaleCommand(
  command: string,
  args: string[],
  options: TailscaleCommandOptions = {},
): Promise<TailscaleCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultCommandRunner(
  command: string,
  timeoutMs: number,
): TailscaleCommandRunner {
  return (args, options) =>
    runTailscaleCommand(command, args, {
      ...options,
      timeoutMs: options?.timeoutMs ?? timeoutMs,
    });
}

function normalizeAddr(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_TAILSCALE_TUNNEL_ADDR;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePublicUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replace(/\.$/, '');
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.endsWith('.ts.net')) return null;
  return parsed.toString().replace(/\/$/, '');
}

function publicUrlFromStatusJson(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const self = isRecord(value.Self) ? value.Self : null;
  return (
    normalizePublicUrl(self?.DNSName) ||
    normalizePublicUrl(self?.HostName) ||
    normalizePublicUrl(value.DNSName) ||
    normalizePublicUrl(value.HostName)
  );
}

function publicUrlFromFunnelStatusJson(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const tcp = isRecord(value.TCP) ? value.TCP : null;
  const tcp443 = tcp && isRecord(tcp['443']) ? tcp['443'] : null;
  const allowFunnel = isRecord(value.AllowFunnel) ? value.AllowFunnel : null;
  return (
    normalizePublicUrl(value.URL) ||
    normalizePublicUrl(value.PublicURL) ||
    normalizePublicUrl(tcp443?.URL) ||
    normalizePublicUrl(allowFunnel?.['443'])
  );
}

function publicUrlFromText(value: string): string | null {
  const match = value.match(/https:\/\/[^\s"'<>]+\.ts\.net\b/i);
  return normalizePublicUrl(match?.[0]);
}

function isTailscaleLoggedOutError(message: string): boolean {
  return /not logged in|logged out|not authenticated|needs login/i.test(
    message,
  );
}

export class TailscaleTunnelProvider implements TunnelProvider {
  private readonly addr: string;
  private readonly commandTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;
  private readonly readSecret: (secretName: string) => string | null;
  private readonly reconnectInitialBackoffMs: number;
  private readonly reconnectMaxBackoffMs: number;
  private readonly recordAuditEvent: TunnelAuditRecorder;
  private readonly runCommand: TailscaleCommandRunner;
  private readonly statusTracker: TunnelStatusTracker;
  private readonly tokenSecretName: string;
  private healthTimer: TunnelTimer | null = null;
  private publicUrl: string | null = null;
  private reconnectTimer: TunnelTimer | null = null;
  private tunnelRunId: string | null = null;

  constructor(options: TailscaleTunnelProviderOptions = {}) {
    this.addr = normalizeAddr(options.addr);
    this.commandTimeoutMs = normalizeDurationMs(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    this.healthCheckIntervalMs = normalizeDurationMs(
      options.healthCheckIntervalMs,
      DEFAULT_HEALTH_INTERVAL_MS,
    );
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
    this.runCommand =
      options.runCommand ??
      defaultCommandRunner(
        options.tailscaleCommand ?? 'tailscale',
        this.commandTimeoutMs,
      );
    this.tokenSecretName = options.tokenSecretName?.trim() || TS_AUTHKEY_SECRET;
    this.statusTracker = new TunnelStatusTracker(
      () => this.status(),
      options.onStatusChange,
    );
  }

  async start(): Promise<TunnelStartResult> {
    if (this.publicUrl) {
      return { public_url: this.publicUrl };
    }

    const startReason =
      this.statusTracker.state === 'reconnecting'
        ? 'manual_reconnect'
        : 'started';
    this.clearTimer('healthTimer');
    this.clearTimer('reconnectTimer');
    this.statusTracker.update({
      lastCheckedAt: null,
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'starting',
    });

    const authKey = this.readSecret(this.tokenSecretName)?.trim() || '';
    try {
      const publicUrl = await this.openTunnel(authKey);
      await this.markTunnelUp(publicUrl, startReason);
      this.scheduleHealthCheck();
      return { public_url: publicUrl };
    } catch (error) {
      const message = redactSecret(errorMessage(error), authKey);
      this.clearActiveTunnel({
        lastCheckedAt: null,
        lastError: message,
        nextReconnectAt: null,
        reconnectAttempt: 0,
        state: 'down',
      });
      await this.recordTunnelAudit('tunnel.start_failed', {
        error: message,
        reason: startReason,
      });
      throw new Error(`Failed to start Tailscale Funnel tunnel: ${message}`);
    }
  }

  private async openTunnel(authKey: string): Promise<string> {
    let existingStatus: unknown | null;
    try {
      existingStatus = await this.getStatusJson();
    } catch (error) {
      const message = errorMessage(error);
      if (!authKey) {
        if (isTailscaleLoggedOutError(message)) {
          throw new Error(
            `tailscale is not logged in and ${this.tokenSecretName} is not configured in encrypted runtime secrets. Store it with \`hybridclaw secret set ${this.tokenSecretName} <authkey>\` or run \`tailscale login\` on the host.`,
          );
        }
        throw error;
      }
      existingStatus = null;
    }

    if (!existingStatus && authKey) {
      await this.runCommand(['up'], {
        env: { TS_AUTHKEY: authKey },
        timeoutMs: this.commandTimeoutMs,
      });
    }

    const startResult = await this.runCommand(['funnel', '--bg', this.addr], {
      timeoutMs: this.commandTimeoutMs,
    });
    return this.resolvePublicUrl(startResult);
  }

  async stop(): Promise<void> {
    this.clearTimer('healthTimer');
    this.clearTimer('reconnectTimer');
    const { publicUrl, tunnelRunId } = this.clearActiveTunnel({
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
    try {
      await this.runCommand(['funnel', '--bg', 'off'], {
        timeoutMs: this.commandTimeoutMs,
      });
    } catch {
      console.warn(
        '[tunnel] failed to stop Tailscale Funnel cleanly; local tunnel state was cleared.',
      );
    }
  }

  status(): TunnelStatus {
    return this.statusTracker.snapshot(Boolean(this.publicUrl), this.publicUrl);
  }

  private async getStatusJson(): Promise<unknown> {
    const result = await this.runCommand(['status', '--json'], {
      timeoutMs: this.commandTimeoutMs,
    });
    return parseJson(result.stdout);
  }

  private async resolvePublicUrl(
    startResult: TailscaleCommandResult,
  ): Promise<string> {
    const fromStartOutput =
      publicUrlFromText(startResult.stdout) ||
      publicUrlFromText(startResult.stderr);
    if (fromStartOutput) return fromStartOutput;

    // Older and newer Tailscale CLI builds differ in how chatty `funnel --bg`
    // is, so prefer its output when present and fall back to structured status.
    const funnelStatus = await this.runCommand(['funnel', 'status', '--json'], {
      timeoutMs: this.commandTimeoutMs,
    }).catch(() => null);
    if (funnelStatus) {
      const fromFunnelStatus =
        publicUrlFromFunnelStatusJson(parseJson(funnelStatus.stdout)) ||
        publicUrlFromText(funnelStatus.stdout) ||
        publicUrlFromText(funnelStatus.stderr);
      if (fromFunnelStatus) return fromFunnelStatus;
    }

    const fromStatus = publicUrlFromStatusJson(await this.getStatusJson());
    if (fromStatus) return fromStatus;

    throw new Error('tailscale did not report a public ts.net URL.');
  }

  private clearTimer(name: 'healthTimer' | 'reconnectTimer'): void {
    const timer = this[name];
    if (!timer) return;
    clearTimeout(timer);
    this[name] = null;
  }

  private scheduleHealthCheck(): void {
    this.clearTimer('healthTimer');
    if (!this.publicUrl || this.statusTracker.state !== 'up') return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);
    this.healthTimer.unref();
  }

  private async runHealthCheck(): Promise<void> {
    const publicUrl = this.publicUrl;
    if (!publicUrl || this.statusTracker.state !== 'up') return;

    const checkedAt = new Date().toISOString();
    try {
      const currentPublicUrl = await this.getActiveFunnelPublicUrl();
      if (!currentPublicUrl) {
        throw new Error(
          'Tailscale Funnel status did not report an active public URL.',
        );
      }
      if (this.publicUrl !== publicUrl || this.statusTracker.state !== 'up')
        return;
      this.publicUrl = currentPublicUrl;
      this.statusTracker.update({
        lastCheckedAt: checkedAt,
        lastError: null,
        nextReconnectAt: null,
        reconnectAttempt: 0,
        state: 'up',
      });
      this.scheduleHealthCheck();
    } catch (error) {
      if (this.publicUrl !== publicUrl || this.statusTracker.state !== 'up')
        return;
      const message = errorMessage(error);
      const { tunnelRunId } = this.clearActiveTunnel({
        lastCheckedAt: checkedAt,
        lastError: message,
        state: 'reconnecting',
      });
      await this.recordTunnelAudit('tunnel.down', {
        error: message,
        publicUrl,
        reason: 'health_check_failed',
        runId: tunnelRunId,
      });
      this.scheduleReconnect(message);
    }
  }

  private async getActiveFunnelPublicUrl(): Promise<string | null> {
    const result = await this.runCommand(['funnel', 'status', '--json'], {
      timeoutMs: this.commandTimeoutMs,
    });
    return (
      publicUrlFromFunnelStatusJson(parseJson(result.stdout)) ||
      publicUrlFromText(result.stdout) ||
      publicUrlFromText(result.stderr)
    );
  }

  private scheduleReconnect(message: string): void {
    const attempt = this.statusTracker.reconnectAttempt + 1;
    const delayMs = Math.min(
      this.reconnectMaxBackoffMs,
      this.reconnectInitialBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
    const nextReconnectAt = new Date(Date.now() + delayMs).toISOString();
    this.statusTracker.update({
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
    this.reconnectTimer.unref();
  }

  private async reconnect(): Promise<void> {
    if (this.statusTracker.state !== 'reconnecting' || this.publicUrl) return;
    const authKey = this.readSecret(this.tokenSecretName)?.trim() || '';
    try {
      const publicUrl = await this.openTunnel(authKey);
      await this.markTunnelUp(publicUrl, 'reconnected');
      this.scheduleHealthCheck();
    } catch (error) {
      this.scheduleReconnect(redactSecret(errorMessage(error), authKey));
    }
  }

  private async markTunnelUp(publicUrl: string, reason: string): Promise<void> {
    const wasRunning = Boolean(this.publicUrl);
    const tunnelRunId = this.tunnelRunId ?? makeTunnelRunId();
    this.publicUrl = publicUrl;
    this.tunnelRunId = tunnelRunId;
    this.statusTracker.update({
      lastCheckedAt: new Date().toISOString(),
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

  private async recordTunnelAudit(
    type: 'tunnel.up' | 'tunnel.down' | 'tunnel.start_failed',
    details: {
      error?: string;
      publicUrl?: string;
      reason: string;
      runId?: string | null;
    },
  ): Promise<void> {
    await recordTunnelAudit({
      auditSessionId: DEFAULT_TUNNEL_AUDIT_SESSION_ID,
      details,
      provider: 'tailscale',
      recordAuditEvent: this.recordAuditEvent,
      type,
    });
  }

  private clearActiveTunnel(update: TunnelStatusUpdate): {
    publicUrl: string | null;
    tunnelRunId: string | null;
  } {
    const publicUrl = this.publicUrl;
    const tunnelRunId = this.tunnelRunId;
    this.publicUrl = null;
    this.tunnelRunId = null;
    this.statusTracker.update(update);
    return { publicUrl, tunnelRunId };
  }
}

export function createTailscaleTunnelProvider(
  options: TailscaleTunnelProviderOptions = {},
): TunnelProvider {
  return new TailscaleTunnelProvider(options);
}
