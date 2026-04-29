import { execFile } from 'node:child_process';
import {
  recordAuditEvent as defaultRecordAuditEvent,
  makeAuditRunId,
  type RecordAuditEventInput,
} from '../audit/audit-events.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import {
  DEFAULT_TUNNEL_HEALTH_CHECK_TIMEOUT_MS as DEFAULT_COMMAND_TIMEOUT_MS,
  type TunnelProvider,
  type TunnelStartResult,
  type TunnelState,
  type TunnelStatus,
} from './tunnel-provider.js';

export const TS_AUTHKEY_SECRET = 'TS_AUTHKEY';
export const DEFAULT_TAILSCALE_TUNNEL_ADDR = 'localhost:9090';

const TUNNEL_AUDIT_SESSION_ID = 'system:tunnel';

type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};
type TailscaleCommandRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<TailscaleCommandResult>;
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

export interface TailscaleTunnelProviderOptions {
  addr?: string | number;
  auditSessionId?: string;
  commandTimeoutMs?: number;
  healthCheckIntervalMs?: number;
  onStatusChange?: (status: TunnelStatus) => void;
  readSecret?: (secretName: string) => string | null;
  recordAuditEvent?: TunnelAuditRecorder;
  runCommand?: TailscaleCommandRunner;
  tailscaleCommand?: string;
  tokenSecretName?: string;
}

function runTailscaleCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<TailscaleCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
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
      timeoutMs: options?.timeoutMs ?? timeoutMs,
    });
}

function normalizeAddr(value: string | number | undefined): string {
  if (typeof value === 'number') {
    return `localhost:${Math.max(1, Math.trunc(value))}`;
  }
  const trimmed = value?.trim();
  return trimmed || DEFAULT_TAILSCALE_TUNNEL_ADDR;
}

function normalizeDurationMs(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSecret(message: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return message;
  return message.replaceAll(trimmed, '<redacted>');
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
  const candidates: unknown[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      candidates.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (/url|dns|name|host/i.test(key)) candidates.push(child);
      collect(child);
    }
  };
  collect(value);
  for (const candidate of candidates) {
    const publicUrl = normalizePublicUrl(candidate);
    if (publicUrl) return publicUrl;
  }
  return null;
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
  private readonly auditSessionId: string;
  private readonly commandTimeoutMs: number;
  private readonly onStatusChange?: (status: TunnelStatus) => void;
  private readonly readSecret: (secretName: string) => string | null;
  private readonly recordAuditEvent: TunnelAuditRecorder;
  private readonly runCommand: TailscaleCommandRunner;
  private readonly tokenSecretName: string;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;
  private nextReconnectAt: string | null = null;
  private publicUrl: string | null = null;
  private reconnectAttempt = 0;
  private state: TunnelState = 'down';
  private statusVersion = 0;
  private tunnelRunId: string | null = null;

  constructor(options: TailscaleTunnelProviderOptions = {}) {
    this.addr = normalizeAddr(options.addr);
    this.auditSessionId =
      options.auditSessionId?.trim() || TUNNEL_AUDIT_SESSION_ID;
    this.commandTimeoutMs = normalizeDurationMs(
      options.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    this.onStatusChange = options.onStatusChange;
    this.readSecret = options.readSecret ?? readStoredRuntimeSecret;
    this.recordAuditEvent = options.recordAuditEvent ?? defaultRecordAuditEvent;
    this.runCommand =
      options.runCommand ??
      defaultCommandRunner(
        options.tailscaleCommand ?? 'tailscale',
        this.commandTimeoutMs,
      );
    this.tokenSecretName = options.tokenSecretName?.trim() || TS_AUTHKEY_SECRET;
  }

  async start(): Promise<TunnelStartResult> {
    if (this.publicUrl) {
      return { public_url: this.publicUrl };
    }

    this.updateStatus({
      lastCheckedAt: null,
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'starting',
    });

    const authKey = this.readSecret(this.tokenSecretName)?.trim() || '';
    try {
      const existingStatus = await this.getStatusJson().catch((error) => {
        if (!authKey && isTailscaleLoggedOutError(errorMessage(error))) {
          throw new Error(
            `tailscale is not logged in and ${this.tokenSecretName} is not configured in encrypted runtime secrets. Store it with \`hybridclaw secret set ${this.tokenSecretName} <authkey>\` or run \`tailscale login\` on the host.`,
          );
        }
        return null;
      });
      if (!existingStatus && authKey) {
        await this.runCommand(['up', '--auth-key', authKey], {
          timeoutMs: this.commandTimeoutMs,
        });
      }

      const startResult = await this.runCommand(['funnel', '--bg', this.addr], {
        timeoutMs: this.commandTimeoutMs,
      });
      const publicUrl = await this.resolvePublicUrl(startResult);
      await this.markTunnelUp(publicUrl, 'started');
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
        reason: 'started',
      });
      throw new Error(`Failed to start Tailscale Funnel tunnel: ${message}`);
    }
  }

  async stop(): Promise<void> {
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
    return {
      running: Boolean(this.publicUrl),
      public_url: this.publicUrl,
      state: this.state,
      last_error: this.lastError,
      last_checked_at: this.lastCheckedAt,
      next_reconnect_at: this.nextReconnectAt,
      reconnect_attempt: this.reconnectAttempt,
    };
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

  private async markTunnelUp(publicUrl: string, reason: string): Promise<void> {
    const wasRunning = Boolean(this.publicUrl);
    const tunnelRunId = this.tunnelRunId ?? makeAuditRunId('tunnel');
    this.publicUrl = publicUrl;
    this.tunnelRunId = tunnelRunId;
    this.updateStatus({
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
    try {
      await this.recordAuditEvent({
        sessionId: this.auditSessionId,
        runId: details.runId ?? makeAuditRunId('tunnel'),
        event: {
          type,
          provider: 'tailscale',
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
    publicUrl: string | null;
    tunnelRunId: string | null;
  } {
    const publicUrl = this.publicUrl;
    const tunnelRunId = this.tunnelRunId;
    this.publicUrl = null;
    this.tunnelRunId = null;
    this.updateStatus(update);
    return { publicUrl, tunnelRunId };
  }
}

export function createTailscaleTunnelProvider(
  options: TailscaleTunnelProviderOptions = {},
): TunnelProvider {
  return new TailscaleTunnelProvider(options);
}
