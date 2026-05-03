import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_CERT_PEM_SECRET,
  CLOUDFLARE_TUNNEL_JSON_SECRET,
  CLOUDFLARE_TUNNEL_TOKEN_SECRET,
  type CloudflaredProcess,
  CloudflareTunnelProvider,
} from '../src/tunnel/cloudflare-tunnel-provider.js';

class FakeCloudflaredProcess
  extends EventEmitter
  implements CloudflaredProcess
{
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => {
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  });

  emitReady(): void {
    this.stderr.write('Connection 1 registered connIndex=0\n');
  }
}

function makeStatusAuditRecorder() {
  return vi.fn(async () => {});
}

describe('CloudflareTunnelProvider', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { force: true, recursive: true });
      tmpDir = null;
    }
  });

  it('runs cloudflared with a tunnel token from encrypted runtime secrets', async () => {
    const fakeProcess = new FakeCloudflaredProcess();
    const runProcess = vi.fn(() => {
      queueMicrotask(() => fakeProcess.emitReady());
      return fakeProcess;
    });
    const recordAuditEvent = makeStatusAuditRecorder();
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'https://bot.example.com',
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent,
      runProcess,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://bot.example.com',
    });

    expect(runProcess).toHaveBeenCalledWith(['tunnel', 'run'], {
      env: { TUNNEL_TOKEN: 'cf-token-secret' },
    });
    expect(provider.status()).toMatchObject({
      running: true,
      public_url: 'https://bot.example.com',
      state: 'up',
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          provider: 'cloudflare',
          public_url: 'https://bot.example.com',
          type: 'tunnel.up',
        }),
      }),
    );

    await provider.stop();
    expect(fakeProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses cert.pem and tunnel.json secrets for locally managed tunnels', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cf-test-'));
    const fakeProcess = new FakeCloudflaredProcess();
    const runProcess = vi.fn(() => {
      queueMicrotask(() => fakeProcess.emitReady());
      return fakeProcess;
    });
    const tunnelJson = JSON.stringify({
      AccountTag: 'account',
      TunnelID: '11111111-2222-3333-4444-555555555555',
      TunnelSecret: 'local-tunnel-secret',
    });
    const provider = new CloudflareTunnelProvider({
      addr: '127.0.0.1:19090',
      publicUrl: 'bot.example.com',
      readSecret: (name) => {
        if (name === CLOUDFLARE_CERT_PEM_SECRET) return '-----BEGIN CERT-----';
        if (name === CLOUDFLARE_TUNNEL_JSON_SECRET) return tunnelJson;
        return null;
      },
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
      tempRootDir: tmpDir,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://bot.example.com',
    });

    const args = runProcess.mock.calls[0]?.[0] ?? [];
    expect(args.slice(0, 4)).toEqual(['tunnel', '--config', args[2], 'run']);
    expect(args[4]).toBe('11111111-2222-3333-4444-555555555555');
    const config = fs.readFileSync(String(args[2]), 'utf-8');
    expect(config).toContain('hostname: "bot.example.com"');
    expect(config).toContain('service: "http://127.0.0.1:19090"');
    expect(config).not.toContain('local-tunnel-secret');

    await provider.stop();
    expect(fs.existsSync(path.dirname(String(args[2])))).toBe(false);
  });

  it('cleans up temporary credential files when local config writing fails', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cf-test-'));
    const writeFileSync = vi
      .spyOn(fs, 'writeFileSync')
      .mockImplementation(() => {
        throw new Error('disk full');
      });
    const tunnelJson = JSON.stringify({
      AccountTag: 'account',
      TunnelID: '11111111-2222-3333-4444-555555555555',
      TunnelSecret: 'local-tunnel-secret',
    });
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'bot.example.com',
      readSecret: (name) => {
        if (name === CLOUDFLARE_CERT_PEM_SECRET) return '-----BEGIN CERT-----';
        if (name === CLOUDFLARE_TUNNEL_JSON_SECRET) return tunnelJson;
        return null;
      },
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess: vi.fn(),
      tempRootDir: tmpDir,
    });

    try {
      await expect(provider.start()).rejects.toThrow('disk full');
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      writeFileSync.mockRestore();
    }
  });

  it('uses cloudflaredCommand without a custom process runner', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-cf-test-'));
    const commandPath = path.join(tmpDir, 'fake-cloudflared');
    fs.writeFileSync(
      commandPath,
      [
        '#!/bin/sh',
        'echo "Registered tunnel connection" >&2',
        'while true; do sleep 1; done',
        '',
      ].join('\n'),
      { mode: 0o700 },
    );
    const provider = new CloudflareTunnelProvider({
      cloudflaredCommand: commandPath,
      healthCheckIntervalMs: 60_000,
      publicUrl: 'https://bot.example.com',
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent: makeStatusAuditRecorder(),
      startupTimeoutMs: 1_000,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://bot.example.com',
    });
    expect(provider.status()).toMatchObject({
      running: true,
      public_url: 'https://bot.example.com',
      state: 'up',
    });
    await provider.stop();
  });

  it('fails gracefully when Cloudflare credentials are missing', async () => {
    const runProcess = vi.fn();
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'https://bot.example.com',
      readSecret: () => null,
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
    });

    await expect(provider.start()).rejects.toThrow(
      'Cloudflare Tunnel credentials are not configured',
    );
    expect(runProcess).not.toHaveBeenCalled();
    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    expect(provider.status().last_error).toContain(
      CLOUDFLARE_TUNNEL_TOKEN_SECRET,
    );
  });

  it('requires a configured public URL before starting', async () => {
    const runProcess = vi.fn();
    const provider = new CloudflareTunnelProvider({
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
    });

    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    await expect(provider.start()).rejects.toThrow('deployment.public_url');
    expect(runProcess).not.toHaveBeenCalled();
  });

  it('is idempotent while the daemon is already running', async () => {
    const fakeProcess = new FakeCloudflaredProcess();
    const runProcess = vi.fn(() => {
      queueMicrotask(() => fakeProcess.emitReady());
      return fakeProcess;
    });
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'https://bot.example.com',
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://bot.example.com',
    });
    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://bot.example.com',
    });

    expect(runProcess).toHaveBeenCalledTimes(1);
    await provider.stop();
  });

  it('health-checks the active tunnel at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const fakeProcess = new FakeCloudflaredProcess();
      const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
      const statusChanges: unknown[] = [];
      const runProcess = vi.fn(() => {
        queueMicrotask(() => fakeProcess.emitReady());
        return fakeProcess;
      });
      const provider = new CloudflareTunnelProvider({
        fetch,
        healthCheckIntervalMs: 250,
        onStatusChange: (status) => statusChanges.push(status),
        publicUrl: 'https://bot.example.com',
        readSecret: (name) =>
          name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
        recordAuditEvent: makeStatusAuditRecorder(),
        runProcess,
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(249);
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledWith('https://bot.example.com/health', {
        method: 'GET',
        signal: expect.any(AbortSignal),
      });
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://bot.example.com',
        state: 'up',
        last_error: null,
      });
      expect(provider.status().last_checked_at).toEqual(expect.any(String));
      expect(statusChanges).toEqual(
        expect.arrayContaining([expect.objectContaining({ state: 'up' })]),
      );

      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects when a health check fails', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const firstProcess = new FakeCloudflaredProcess();
      const secondProcess = new FakeCloudflaredProcess();
      const runProcess = vi
        .fn()
        .mockImplementationOnce(() => {
          queueMicrotask(() => firstProcess.emitReady());
          return firstProcess;
        })
        .mockImplementationOnce(() => {
          queueMicrotask(() => secondProcess.emitReady());
          return secondProcess;
        });
      const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
      const recordAuditEvent = makeStatusAuditRecorder();
      const provider = new CloudflareTunnelProvider({
        fetch,
        healthCheckIntervalMs: 100,
        publicUrl: 'https://bot.example.com',
        readSecret: (name) =>
          name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
        reconnectInitialBackoffMs: 50,
        reconnectMaxBackoffMs: 75,
        recordAuditEvent,
        runProcess,
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(firstProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(provider.status()).toMatchObject({
        running: false,
        public_url: null,
        state: 'reconnecting',
        last_error: 'tunnel health check returned HTTP 503',
        reconnect_attempt: 1,
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(runProcess).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(runProcess).toHaveBeenCalledTimes(2);
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://bot.example.com',
        state: 'up',
        last_error: null,
        reconnect_attempt: 0,
      });
      expect(
        recordAuditEvent.mock.calls.map((call) => call[0].event.type),
      ).toEqual(['tunnel.up', 'tunnel.down', 'tunnel.up']);

      await provider.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('warns instead of throwing when daemon cleanup fails', async () => {
    const fakeProcess = new FakeCloudflaredProcess();
    fakeProcess.kill.mockImplementation(() => {
      throw new Error('permission denied');
    });
    const runProcess = vi.fn(() => {
      queueMicrotask(() => fakeProcess.emitReady());
      return fakeProcess;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'https://bot.example.com',
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
    });

    await provider.start();
    await expect(provider.stop()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[tunnel] failed to stop Cloudflare Tunnel cleanly; local tunnel state was cleared.',
    );
    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    warn.mockRestore();
  });

  it('redacts credentials from start failures', async () => {
    const fakeProcess = new FakeCloudflaredProcess();
    const runProcess = vi.fn(() => {
      queueMicrotask(() =>
        fakeProcess.emit('error', new Error('failed auth cf-token-secret')),
      );
      return fakeProcess;
    });
    const provider = new CloudflareTunnelProvider({
      publicUrl: 'https://bot.example.com',
      readSecret: (name) =>
        name === CLOUDFLARE_TUNNEL_TOKEN_SECRET ? 'cf-token-secret' : null,
      recordAuditEvent: makeStatusAuditRecorder(),
      runProcess,
    });

    let thrown: Error | null = null;
    try {
      await provider.start();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown?.message).toContain('<redacted>');
    expect(thrown?.message).not.toContain('cf-token-secret');
  });
});
