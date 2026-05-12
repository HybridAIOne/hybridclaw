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
    const runCommand = vi.fn(
      async (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (args.join(' ') === 'status --json') {
          throw new Error('not logged in');
        }
        if (
          args.join(' ') === 'up' &&
          options?.env?.TS_AUTHKEY === 'test-auth-key'
        ) {
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
      },
    );
    const provider = new TailscaleTunnelProvider({
      readSecret: (secretName) =>
        secretName === 'TS_AUTHKEY' ? ' test-auth-key ' : null,
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://gateway.example.ts.net',
    });
    const upCall = runCommand.mock.calls.find(
      (call) => call[0].join(' ') === 'up',
    );
    expect(upCall?.[0]).toEqual(['up']);
    expect(upCall?.[0]).not.toContain('test-auth-key');
    expect(runCommand).toHaveBeenCalledWith(
      ['up'],
      { env: { TS_AUTHKEY: 'test-auth-key' }, timeoutMs: 5_000 },
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
    const runCommand = vi.fn(async () => {
      throw new Error('spawn tailscale ENOENT');
    });
    const provider = new TailscaleTunnelProvider({
      readSecret: () => null,
      recordAuditEvent: vi.fn(),
      runCommand,
    });

    await expect(provider.start()).rejects.toThrow('spawn tailscale ENOENT');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(provider.status().last_error).toBe('spawn tailscale ENOENT');
  });

  it('reconnects with capped backoff when Funnel health checks fail', async () => {
    vi.useFakeTimers();
    try {
      const runCommand = vi.fn(async (args: string[]) => {
        const command = args.join(' ');
        if (command === 'status --json') {
          return {
            stdout: JSON.stringify({
              Self: { DNSName: 'health.example.ts.net.' },
            }),
            stderr: '',
          };
        }
        if (command === 'funnel --bg localhost:9090') {
          const attempt = runCommand.mock.calls.filter(
            (call) => call[0].join(' ') === command,
          ).length;
          return {
            stdout:
              attempt === 1
                ? 'Available on the internet:\nhttps://first.example.ts.net\n'
                : 'Available on the internet:\nhttps://second.example.ts.net\n',
            stderr: '',
          };
        }
        if (command === 'funnel status --json') {
          return {
            stdout: JSON.stringify({}),
            stderr: '',
          };
        }
        throw new Error(`unexpected command: ${command}`);
      });
      const recordAuditEvent = vi.fn();
      const provider = new TailscaleTunnelProvider({
        healthCheckIntervalMs: 100,
        reconnectInitialBackoffMs: 50,
        reconnectMaxBackoffMs: 50,
        recordAuditEvent,
        runCommand,
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(provider.status()).toMatchObject({
        running: false,
        public_url: null,
        state: 'reconnecting',
        last_error:
          'Tailscale Funnel status did not report an active public URL.',
        reconnect_attempt: 1,
      });
      expect(provider.status().last_checked_at).toEqual(expect.any(String));
      expect(provider.status().next_reconnect_at).toEqual(expect.any(String));
      expect(recordAuditEvent.mock.calls[1]?.[0].event).toMatchObject({
        provider: 'tailscale',
        public_url: 'https://first.example.ts.net',
        reason: 'health_check_failed',
      });

      await vi.advanceTimersByTimeAsync(50);

      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://second.example.ts.net',
        state: 'up',
        last_error: null,
        reconnect_attempt: 0,
        next_reconnect_at: null,
      });
      expect(
        recordAuditEvent.mock.calls.map((call) => call[0].event.type),
      ).toEqual(['tunnel.up', 'tunnel.down', 'tunnel.up']);
    } finally {
      vi.useRealTimers();
    }
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
    const runCommand = vi.fn(
      async (args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        if (args.join(' ') === 'status --json') {
          throw new Error('not logged in');
        }
        if (
          args.join(' ') === 'up' &&
          options?.env?.TS_AUTHKEY === 'secret-auth-key'
        ) {
          throw new Error('auth failed for secret-auth-key');
        }
        throw new Error(`unexpected command: ${args.join(' ')}`);
      },
    );
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
