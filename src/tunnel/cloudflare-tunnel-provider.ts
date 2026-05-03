import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordAuditEvent as defaultRecordAuditEvent } from '../audit/audit-events.js';
import { readStoredRuntimeSecret } from '../security/runtime-secrets.js';
import type {
  TunnelProvider,
  TunnelStartResult,
  TunnelStatus,
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
} from './tunnel-provider-utils.js';

export const CLOUDFLARE_TUNNEL_TOKEN_SECRET = 'CLOUDFLARE_TUNNEL_TOKEN';
export const CLOUDFLARE_CERT_PEM_SECRET = 'CLOUDFLARE_CERT_PEM';
export const CLOUDFLARE_TUNNEL_JSON_SECRET = 'CLOUDFLARE_TUNNEL_JSON';
export const DEFAULT_CLOUDFLARE_TUNNEL_ADDR = 'localhost:9090';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const READY_OUTPUT_RE =
  /connection .+ registered|registered tunnel connection|tunnel server connection/i;

type CloudflaredProcessOptions = {
  env?: NodeJS.ProcessEnv;
};

export interface CloudflaredProcess {
  stderr: NodeJS.ReadableStream;
  stdout: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  off(event: 'error', listener: (error: Error) => void): this;
  off(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

type CloudflaredProcessRunner = (
  args: string[],
  options?: CloudflaredProcessOptions,
) => CloudflaredProcess;

export interface CloudflareTunnelProviderOptions {
  addr?: string;
  certPemSecretName?: string;
  cloudflaredCommand?: string;
  onStatusChange?: (status: TunnelStatus) => void;
  publicUrl?: string;
  readSecret?: (secretName: string) => string | null;
  recordAuditEvent?: TunnelAuditRecorder;
  runProcess?: CloudflaredProcessRunner;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  tempRootDir?: string;
  tokenSecretName?: string;
  tunnelJsonSecretName?: string;
}

type CloudflareAuth =
  | {
      args: string[];
      env: NodeJS.ProcessEnv;
      secrets: string[];
      tempDir: string | null;
    }
  | {
      args: string[];
      env?: undefined;
      secrets: string[];
      tempDir: string;
    };

function defaultProcessRunner(command: string): CloudflaredProcessRunner {
  return (args, options) =>
    spawn(command, args, {
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }) as unknown as CloudflaredProcess;
}

function normalizeAddr(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_CLOUDFLARE_TUNNEL_ADDR;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '');
  return `http://${trimmed.replace(/\/$/, '')}`;
}

function normalizePublicUrl(value: string | undefined): string | null {
  const raw = value?.trim() || '';
  if (!raw) {
    return null;
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Cloudflare Tunnel public URL is invalid: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Cloudflare Tunnel public URL must be HTTP(S): ${parsed.protocol}`,
    );
  }
  return parsed.origin;
}

function hostnameFromPublicUrl(publicUrl: string): string {
  return new URL(publicUrl).hostname;
}

function parseTunnelId(tunnelJson: string): string {
  try {
    const parsed = JSON.parse(tunnelJson) as { TunnelID?: unknown };
    if (typeof parsed.TunnelID === 'string' && parsed.TunnelID.trim()) {
      return parsed.TunnelID.trim();
    }
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error('CLOUDFLARE_TUNNEL_JSON must contain a TunnelID string.');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function redactSecrets(message: string, secrets: string[]): string {
  return secrets.reduce(
    (current, secret) => redactSecret(current, secret),
    message,
  );
}

function removeTempDir(tempDir: string | null): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { force: true, recursive: true });
  } catch (error) {
    console.warn(
      '[tunnel] failed to remove temporary cloudflared credential files.',
      errorMessage(error),
    );
  }
}

function exitMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  if (signal) return `cloudflared exited with signal ${signal}`;
  return `cloudflared exited with code ${code ?? 'unknown'}`;
}

export class CloudflareTunnelProvider implements TunnelProvider {
  private readonly addr: string;
  private readonly certPemSecretName: string;
  private readonly publicUrl: string | null;
  private readonly readSecret: (secretName: string) => string | null;
  private readonly recordAuditEvent: TunnelAuditRecorder;
  private readonly runProcess: CloudflaredProcessRunner;
  private readonly startupTimeoutMs: number;
  private readonly statusTracker: TunnelStatusTracker;
  private readonly stopTimeoutMs: number;
  private readonly tempRootDir: string;
  private readonly tokenSecretName: string;
  private readonly tunnelJsonSecretName: string;
  private process: CloudflaredProcess | null = null;
  private processTempDir: string | null = null;
  private tunnelRunId: string | null = null;

  constructor(options: CloudflareTunnelProviderOptions = {}) {
    this.addr = normalizeAddr(options.addr);
    this.certPemSecretName =
      options.certPemSecretName?.trim() || CLOUDFLARE_CERT_PEM_SECRET;
    this.publicUrl = normalizePublicUrl(options.publicUrl);
    this.readSecret = options.readSecret ?? readStoredRuntimeSecret;
    this.recordAuditEvent = options.recordAuditEvent ?? defaultRecordAuditEvent;
    this.runProcess =
      options.runProcess ??
      defaultProcessRunner(options.cloudflaredCommand ?? 'cloudflared');
    this.startupTimeoutMs = normalizeDurationMs(
      options.startupTimeoutMs,
      DEFAULT_STARTUP_TIMEOUT_MS,
    );
    this.stopTimeoutMs = normalizeDurationMs(
      options.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
    );
    this.tempRootDir = options.tempRootDir ?? os.tmpdir();
    this.tokenSecretName =
      options.tokenSecretName?.trim() || CLOUDFLARE_TUNNEL_TOKEN_SECRET;
    this.tunnelJsonSecretName =
      options.tunnelJsonSecretName?.trim() || CLOUDFLARE_TUNNEL_JSON_SECRET;
    this.statusTracker = new TunnelStatusTracker(
      () => this.status(),
      options.onStatusChange,
    );
  }

  async start(): Promise<TunnelStartResult> {
    if (this.process && this.publicUrl) {
      return { public_url: this.publicUrl };
    }

    const startReason =
      this.statusTracker.state === 'reconnecting'
        ? 'manual_reconnect'
        : 'started';
    this.statusTracker.update({
      lastCheckedAt: null,
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'starting',
    });

    let auth: CloudflareAuth | null = null;
    try {
      const publicUrl = this.requirePublicUrl();
      auth = this.resolveAuth(publicUrl);
      const process = await this.startCloudflared(auth);
      await this.markTunnelUp(process, auth.tempDir, publicUrl, startReason);
      return { public_url: publicUrl };
    } catch (error) {
      const message = redactSecrets(errorMessage(error), auth?.secrets ?? []);
      this.clearActiveTunnel({
        lastCheckedAt: null,
        lastError: message,
        nextReconnectAt: null,
        reconnectAttempt: 0,
        state: 'down',
      });
      removeTempDir(auth?.tempDir ?? null);
      await this.recordTunnelAudit('tunnel.start_failed', {
        error: message,
        reason: startReason,
      });
      throw new Error(`Failed to start Cloudflare Tunnel: ${message}`);
    }
  }

  async stop(): Promise<void> {
    const { process, publicUrl, tempDir, tunnelRunId } = this.clearActiveTunnel(
      {
        lastCheckedAt: null,
        lastError: null,
        nextReconnectAt: null,
        reconnectAttempt: 0,
        state: 'down',
      },
    );
    if (publicUrl) {
      await this.recordTunnelAudit('tunnel.down', {
        publicUrl,
        reason: 'stopped',
        runId: tunnelRunId,
      });
    }
    if (process) {
      await this.stopProcess(process);
    }
    removeTempDir(tempDir);
  }

  status(): TunnelStatus {
    return this.statusTracker.snapshot(
      Boolean(this.process),
      this.process ? this.publicUrl : null,
    );
  }

  private requirePublicUrl(): string {
    if (this.publicUrl) return this.publicUrl;
    throw new Error(
      'Cloudflare Tunnel public URL is not configured. Set deployment.public_url to the hostname bound to the Cloudflare tunnel.',
    );
  }

  private resolveAuth(publicUrl: string): CloudflareAuth {
    const token = this.readSecret(this.tokenSecretName)?.trim() || '';
    if (token) {
      return {
        args: ['tunnel', 'run'],
        env: { TUNNEL_TOKEN: token },
        secrets: [token],
        tempDir: null,
      };
    }

    const certPem = this.readSecret(this.certPemSecretName)?.trim() || '';
    const tunnelJson = this.readSecret(this.tunnelJsonSecretName)?.trim() || '';
    if (!certPem || !tunnelJson) {
      throw new Error(
        `Cloudflare Tunnel credentials are not configured in encrypted runtime secrets. Store ${this.tokenSecretName}, or store ${this.certPemSecretName} and ${this.tunnelJsonSecretName}.`,
      );
    }

    const tunnelId = parseTunnelId(tunnelJson);
    const tempDir = fs.mkdtempSync(
      path.join(this.tempRootDir, 'hybridclaw-cloudflared-'),
    );
    const certPath = path.join(tempDir, 'cert.pem');
    const credentialsPath = path.join(tempDir, 'tunnel.json');
    const configPath = path.join(tempDir, 'config.yml');
    fs.writeFileSync(certPath, certPem, { mode: 0o600 });
    fs.writeFileSync(credentialsPath, tunnelJson, { mode: 0o600 });
    fs.writeFileSync(
      configPath,
      [
        `tunnel: ${yamlString(tunnelId)}`,
        `credentials-file: ${yamlString(credentialsPath)}`,
        `origincert: ${yamlString(certPath)}`,
        'ingress:',
        `  - hostname: ${yamlString(hostnameFromPublicUrl(publicUrl))}`,
        `    service: ${yamlString(this.addr)}`,
        '  - service: http_status:404',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    return {
      args: ['tunnel', '--config', configPath, 'run', tunnelId],
      secrets: [certPem, tunnelJson],
      tempDir,
    };
  }

  private async startCloudflared(
    auth: CloudflareAuth,
  ): Promise<CloudflaredProcess> {
    const process = this.runProcess(auth.args, { env: auth.env });
    let output = '';

    return await new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        process.off('error', onError);
        process.off('exit', onExit);
        process.stdout.off('data', onData);
        process.stderr.off('data', onData);
      };
      const resolveReady = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(process);
      };
      const rejectStart = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          process.kill('SIGTERM');
        } catch {
          // Process may have failed before it became killable.
        }
        reject(error);
      };
      const onData = (chunk: Buffer | string): void => {
        output += chunk.toString();
        if (READY_OUTPUT_RE.test(output)) {
          resolveReady();
        }
      };
      const onError = (error: Error): void => {
        rejectStart(error);
      };
      const onExit = (
        code: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        rejectStart(new Error(`${exitMessage(code, signal)}. ${output}`));
      };
      const timer = setTimeout(() => {
        rejectStart(
          new Error(
            `cloudflared did not report a ready tunnel within ${this.startupTimeoutMs}ms. ${output}`,
          ),
        );
      }, this.startupTimeoutMs);
      timer.unref();

      process.stdout.on('data', onData);
      process.stderr.on('data', onData);
      process.once('error', onError);
      process.once('exit', onExit);
    });
  }

  private async markTunnelUp(
    process: CloudflaredProcess,
    tempDir: string | null,
    publicUrl: string,
    reason: string,
  ): Promise<void> {
    const tunnelRunId = this.tunnelRunId ?? makeTunnelRunId();
    this.process = process;
    this.processTempDir = tempDir;
    this.tunnelRunId = tunnelRunId;
    this.statusTracker.update({
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'up',
    });
    process.once('exit', (code, signal) => {
      void this.handleProcessExit(process, code, signal);
    });
    await this.recordTunnelAudit('tunnel.up', {
      publicUrl,
      reason,
      runId: tunnelRunId,
    });
  }

  private async handleProcessExit(
    process: CloudflaredProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.process !== process) return;
    const message = exitMessage(code, signal);
    const { publicUrl, tempDir, tunnelRunId } = this.clearActiveTunnel({
      lastCheckedAt: new Date().toISOString(),
      lastError: message,
      nextReconnectAt: null,
      reconnectAttempt: 0,
      state: 'down',
    });
    removeTempDir(tempDir);
    if (publicUrl) {
      await this.recordTunnelAudit('tunnel.down', {
        error: message,
        publicUrl,
        reason: 'process_exited',
        runId: tunnelRunId,
      });
    }
  }

  private async stopProcess(process: CloudflaredProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.off('exit', onExit);
        resolve();
      };
      const onExit = (): void => finish();
      const timer = setTimeout(() => {
        try {
          process.kill('SIGKILL');
        } catch {
          // The process may already have exited.
        }
        console.warn(
          '[tunnel] failed to stop Cloudflare Tunnel cleanly; local tunnel state was cleared.',
        );
        finish();
      }, this.stopTimeoutMs);
      timer.unref();
      process.once('exit', onExit);
      try {
        process.kill('SIGTERM');
      } catch {
        console.warn(
          '[tunnel] failed to stop Cloudflare Tunnel cleanly; local tunnel state was cleared.',
        );
        finish();
      }
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
    await recordTunnelAudit({
      auditSessionId: DEFAULT_TUNNEL_AUDIT_SESSION_ID,
      details,
      provider: 'cloudflare',
      recordAuditEvent: this.recordAuditEvent,
      type,
    });
  }

  private clearActiveTunnel(update: TunnelStatusUpdate): {
    process: CloudflaredProcess | null;
    publicUrl: string | null;
    tempDir: string | null;
    tunnelRunId: string | null;
  } {
    const process = this.process;
    const publicUrl = this.process ? this.publicUrl : null;
    const tempDir = this.processTempDir;
    const tunnelRunId = this.tunnelRunId;
    this.process = null;
    this.processTempDir = null;
    this.tunnelRunId = null;
    this.statusTracker.update(update);
    return { process, publicUrl, tempDir, tunnelRunId };
  }
}

export function createCloudflareTunnelProvider(
  options: CloudflareTunnelProviderOptions = {},
): TunnelProvider {
  return new CloudflareTunnelProvider(options);
}
