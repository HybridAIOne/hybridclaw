import { describe, expect, it, vi } from 'vitest';

import { TailscaleTunnelProvider } from '../src/tunnel/tailscale-tunnel-provider.js';
import type { TunnelStatus } from '../src/tunnel/tunnel-provider.js';

const DOWN_STATUS: TunnelStatus = {
  running: false,
  public_url: null,
  state: 'down',
  last_error: null,
  last_checked_at: null,
  next_reconnect_at: null,
  reconnect_attempt: 0,
};

describe('TailscaleTunnelProvider', () => {
  it('starts Funnel using an existing tailscaled login', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            Self: { DNSName: 'gateway.example.ts.net.' },
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel --bg localhost:9090') {
        return {
          stdout:
            'Available on the internet:\nhttps://gateway.example.ts.net\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const recordAuditEvent = vi.fn();
    const provider = new TailscaleTunnelProvider({
      recordAuditEvent,
      runCommand,
    });

    expect(provider.status()).toEqual(DOWN_STATUS);

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://gateway.example.ts.net',
    });
    expect(runCommand).toHaveBeenCalledWith(['status', '--json'], {
      timeoutMs: 5_000,
    });
    expect(runCommand).toHaveBeenCalledWith(
      ['funnel', '--bg', 'localhost:9090'],
      { timeoutMs: 5_000 },
    );
    expect(runCommand).not.toHaveBeenCalledWith(
      expect.arrayContaining(['up']),
      expect.anything(),
    );
    expect(provider.status()).toMatchObject({
      running: true,
      public_url: 'https://gateway.example.ts.net',
      state: 'up',
      last_error: null,
    });
    expect(provider.status().last_checked_at).toEqual(expect.any(String));
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'system:tunnel',
        event: {
          type: 'tunnel.up',
          provider: 'tailscale',
          public_url: 'https://gateway.example.ts.net',
          reason: 'started',
        },
      }),
    );
  });

  it('logs in with TS_AUTHKEY when tailscaled is not already logged in', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        throw new Error('not logged in');
      }
      if (args.join(' ') === 'up --auth-key test-auth-key') {
        return { stdout: '', stderr: '' };
      }
      if (args.join(' ') === 'funnel --bg localhost:9090') {
        return { stdout: '', stderr: '' };
      }
      if (args.join(' ') === 'funnel status --json') {
        return {
          stdout: JSON.stringify({
            TCP: {
              '443': { HTTPS: true, URL: 'https://gateway.example.ts.net' },
            },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const provider = new TailscaleTunnelProvider({
      readSecret: (secretName) =>
        secretName === 'TS_AUTHKEY' ? ' test-auth-key ' : null,
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://gateway.example.ts.net',
    });
    expect(runCommand).toHaveBeenCalledWith(
      ['up', '--auth-key', 'test-auth-key'],
      { timeoutMs: 5_000 },
    );
  });

  it('uses structured Funnel status when start output is quiet', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            Self: { DNSName: 'quiet.example.ts.net.' },
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel --bg localhost:9090') {
        return { stdout: '', stderr: '' };
      }
      if (args.join(' ') === 'funnel status --json') {
        return {
          stdout: JSON.stringify({
            AllowFunnel: {
              '443': 'https://quiet.example.ts.net',
            },
          }),
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const provider = new TailscaleTunnelProvider({
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://quiet.example.ts.net',
    });
    expect(runCommand).toHaveBeenCalledWith(
      ['funnel', 'status', '--json'],
      { timeoutMs: 5_000 },
    );
  });

  it('fails gracefully when tailscaled is logged out and TS_AUTHKEY is missing', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        throw new Error('not logged in');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const recordAuditEvent = vi.fn();
    const provider = new TailscaleTunnelProvider({
      readSecret: () => null,
      recordAuditEvent,
      runCommand,
    });

    await expect(provider.start()).rejects.toThrow('TS_AUTHKEY');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    expect(provider.status().last_error).toContain('TS_AUTHKEY');
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          type: 'tunnel.start_failed',
          provider: 'tailscale',
          reason: 'started',
          error:
            'tailscale is not logged in and TS_AUTHKEY is not configured in encrypted runtime secrets. Store it with `hybridclaw secret set TS_AUTHKEY <authkey>` or run `tailscale login` on the host.',
        },
      }),
    );
  });

  it('does not mask missing tailscale CLI errors as missing auth', async () => {
    const provider = new TailscaleTunnelProvider({
      readSecret: () => null,
      recordAuditEvent: vi.fn(),
      runCommand: vi.fn(async () => {
        throw new Error('spawn tailscale ENOENT');
      }),
    });

    await expect(provider.start()).rejects.toThrow('spawn tailscale ENOENT');
    expect(provider.status().last_error).toBe('spawn tailscale ENOENT');
  });

  it('returns the existing Funnel URL when start is called while running', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            Self: { DNSName: 'stable.example.ts.net.' },
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel --bg localhost:9090') {
        return {
          stdout: 'Available on the internet:\nhttps://stable.example.ts.net\n',
          stderr: '',
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const provider = new TailscaleTunnelProvider({
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://stable.example.ts.net',
    });
    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://stable.example.ts.net',
    });

    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it('redacts TS_AUTHKEY from startup errors', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        throw new Error('not logged in');
      }
      if (args.join(' ') === 'up --auth-key secret-auth-key') {
        throw new Error('auth failed for secret-auth-key');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const recordAuditEvent = vi.fn();
    const provider = new TailscaleTunnelProvider({
      readSecret: () => 'secret-auth-key',
      recordAuditEvent,
      runCommand,
    });

    await expect(provider.start()).rejects.toThrow('<redacted>');
    expect(provider.status().last_error).not.toContain('secret-auth-key');
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
      'secret-auth-key',
    );
  });

  it('clears local state and warns when stopping fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'status --json') {
        return {
          stdout: JSON.stringify({
            Self: { DNSName: 'stop.example.ts.net.' },
          }),
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel --bg localhost:9090') {
        return {
          stdout: 'Available on the internet:\nhttps://stop.example.ts.net\n',
          stderr: '',
        };
      }
      if (args.join(' ') === 'funnel --bg off') {
        throw new Error('stop failed');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const provider = new TailscaleTunnelProvider({
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    try {
      await provider.start();
      await expect(provider.stop()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        '[tunnel] failed to stop Tailscale Funnel cleanly; local tunnel state was cleared.',
      );
      expect(provider.status()).toEqual(DOWN_STATUS);
    } finally {
      warn.mockRestore();
    }
  });

  it('attempts to stop persisted Funnel bindings without local state', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'funnel --bg off') {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const recordAuditEvent = vi.fn();
    const provider = new TailscaleTunnelProvider({
      recordAuditEvent,
      runCommand,
    });

    await expect(provider.stop()).resolves.toBeUndefined();

    expect(runCommand).toHaveBeenCalledWith(['funnel', '--bg', 'off'], {
      timeoutMs: 5_000,
    });
    expect(recordAuditEvent).not.toHaveBeenCalled();
    expect(provider.status()).toEqual(DOWN_STATUS);
  });
});
