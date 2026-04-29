import { describe, expect, it, vi } from 'vitest';

import { NgrokTunnelProvider } from '../src/tunnel/ngrok-tunnel-provider.js';
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

describe('NgrokTunnelProvider', () => {
  it('rejects reconnect backoff configs whose initial delay exceeds the cap', () => {
    expect(
      () =>
        new NgrokTunnelProvider({
          reconnectInitialBackoffMs: 60_000,
          reconnectMaxBackoffMs: 1_000,
        }),
    ).toThrow(
      'reconnectInitialBackoffMs (60000) must be less than or equal to reconnectMaxBackoffMs (1000).',
    );
  });

  it('opens an ngrok tunnel with the encrypted runtime secret token', async () => {
    const close = vi.fn(async () => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => 'https://abc123.ngrok.app/',
    }));
    const recordAuditEvent = vi.fn();
    const provider = new NgrokTunnelProvider({
      addr: 9090,
      loadNgrok: async () => ({ forward }),
      recordAuditEvent,
      readSecret: (secretName) =>
        secretName === 'NGROK_AUTHTOKEN' ? ' test-token ' : null,
    });

    expect(provider.status()).toEqual(DOWN_STATUS);

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://abc123.ngrok.app',
    });
    expect(forward).toHaveBeenCalledWith({
      addr: 9090,
      authtoken: 'test-token',
      proto: 'http',
    });
    expect(provider.status()).toEqual({
      running: true,
      public_url: 'https://abc123.ngrok.app',
      state: 'up',
      last_error: null,
      last_checked_at: null,
      next_reconnect_at: null,
      reconnect_attempt: 0,
    });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'system:tunnel',
        event: {
          type: 'tunnel.up',
          provider: 'ngrok',
          public_url: 'https://abc123.ngrok.app',
          reason: 'started',
        },
      }),
    );
    const upRunId = recordAuditEvent.mock.calls[0]?.[0].runId;

    await provider.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.status()).toEqual(DOWN_STATUS);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'system:tunnel',
        event: {
          type: 'tunnel.down',
          provider: 'ngrok',
          public_url: 'https://abc123.ngrok.app',
          reason: 'stopped',
        },
      }),
    );
    expect(recordAuditEvent.mock.calls[1]?.[0].runId).toBe(upRunId);
  });

  it('does not load ngrok when the auth token is missing', async () => {
    const loadNgrok = vi.fn();
    const recordAuditEvent = vi.fn();
    const provider = new NgrokTunnelProvider({
      loadNgrok,
      recordAuditEvent,
      readSecret: () => null,
    });

    await expect(provider.start()).rejects.toThrow('NGROK_AUTHTOKEN');
    expect(loadNgrok).not.toHaveBeenCalled();
    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    expect(provider.status().last_error).toContain('NGROK_AUTHTOKEN');
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: {
          type: 'tunnel.start_failed',
          provider: 'ngrok',
          reason: 'started',
          error:
            'ngrok auth token is not configured in encrypted runtime secrets. Store it with `hybridclaw secret set NGROK_AUTHTOKEN <token>`.',
        },
      }),
    );
  });

  it('returns the existing tunnel when start is called while running', async () => {
    const close = vi.fn(async () => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => 'https://stable.ngrok.app',
    }));
    const provider = new NgrokTunnelProvider({
      loadNgrok: async () => ({ forward }),
      recordAuditEvent: vi.fn(),
      readSecret: () => 'test-token',
    });

    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://stable.ngrok.app',
    });
    await expect(provider.start()).resolves.toEqual({
      public_url: 'https://stable.ngrok.app',
    });

    expect(forward).toHaveBeenCalledTimes(1);
    await provider.stop();
  });

  it('clears local state and warns when stopping fails', async () => {
    const close = vi.fn(async () => {
      throw new Error('close failed');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => 'https://stop-failure.ngrok.app',
    }));
    const provider = new NgrokTunnelProvider({
      loadNgrok: async () => ({ forward }),
      recordAuditEvent: vi.fn(),
      readSecret: () => 'test-token',
    });

    try {
      await provider.start();
      await expect(provider.stop()).resolves.toBeUndefined();

      expect(close).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[tunnel] failed to stop ngrok tunnel cleanly; local tunnel state was cleared.',
      );
      expect(provider.status()).toEqual(DOWN_STATUS);
    } finally {
      warn.mockRestore();
    }
  });

  it('closes the listener and redacts the token when startup fails after connecting', async () => {
    const close = vi.fn(async () => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => null,
    }));
    const recordAuditEvent = vi.fn();
    const provider = new NgrokTunnelProvider({
      loadNgrok: async () => ({ forward }),
      recordAuditEvent,
      readSecret: () => 'secret-token',
    });

    let thrown: Error | null = null;
    try {
      await provider.start();
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toContain('Failed to start ngrok tunnel');
    expect(thrown?.message).not.toContain('secret-token');
    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.status()).toMatchObject({
      running: false,
      public_url: null,
      state: 'down',
    });
    expect(provider.status().last_error).toContain(
      'Failed to start ngrok tunnel',
    );
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'tunnel.start_failed',
          provider: 'ngrok',
          reason: 'started',
        }),
      }),
    );
    expect(JSON.stringify(recordAuditEvent.mock.calls)).not.toContain(
      'secret-token',
    );
  });

  it('health-checks the active tunnel at the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn(async () => {});
      const forward = vi.fn(async () => ({
        close,
        url: () => 'https://health.ngrok.app',
      }));
      const fetch = vi.fn(async () => ({ ok: true, status: 200 }));
      const statusChanges: TunnelStatus[] = [];
      const provider = new NgrokTunnelProvider({
        fetch,
        healthCheckIntervalMs: 250,
        loadNgrok: async () => ({ forward }),
        onStatusChange: (status) => statusChanges.push(status),
        recordAuditEvent: vi.fn(),
        readSecret: () => 'test-token',
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(249);
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledWith('https://health.ngrok.app/health', {
        method: 'GET',
        signal: expect.any(AbortSignal),
      });
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://health.ngrok.app',
        state: 'up',
        last_error: null,
      });
      expect(provider.status().last_checked_at).toEqual(expect.any(String));
      expect(statusChanges.map((status) => status.state)).toContain('up');

      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects with capped backoff when a health check fails', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const firstClose = vi.fn(async () => {});
      const secondClose = vi.fn(async () => {});
      const forward = vi
        .fn()
        .mockResolvedValueOnce({
          close: firstClose,
          url: () => 'https://first.ngrok.app',
        })
        .mockRejectedValueOnce(new Error('temporary ngrok failure'))
        .mockResolvedValueOnce({
          close: secondClose,
          url: () => 'https://second.ngrok.app',
        });
      const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
      const recordAuditEvent = vi.fn();
      const provider = new NgrokTunnelProvider({
        fetch,
        healthCheckIntervalMs: 100,
        loadNgrok: async () => ({ forward }),
        reconnectInitialBackoffMs: 50,
        reconnectMaxBackoffMs: 75,
        recordAuditEvent,
        readSecret: () => 'test-token',
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(firstClose).toHaveBeenCalledTimes(1);
      expect(provider.status()).toMatchObject({
        running: false,
        public_url: null,
        state: 'reconnecting',
        last_error: 'tunnel health check returned HTTP 503',
        reconnect_attempt: 1,
      });
      expect(provider.status().next_reconnect_at).toEqual(expect.any(String));
      expect(
        recordAuditEvent.mock.calls.map((call) => call[0].event.type),
      ).toEqual(['tunnel.up', 'tunnel.down']);
      expect(recordAuditEvent.mock.calls[1]?.[0].runId).toBe(
        recordAuditEvent.mock.calls[0]?.[0].runId,
      );

      await vi.advanceTimersByTimeAsync(50);
      expect(forward).toHaveBeenCalledTimes(2);
      expect(provider.status()).toMatchObject({
        running: false,
        state: 'reconnecting',
        reconnect_attempt: 2,
      });

      await vi.advanceTimersByTimeAsync(74);
      expect(forward).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1);
      expect(forward).toHaveBeenCalledTimes(3);
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://second.ngrok.app',
        state: 'up',
        last_error: null,
        reconnect_attempt: 0,
      });
      expect(
        recordAuditEvent.mock.calls.map((call) => call[0].event.type),
      ).toEqual(['tunnel.up', 'tunnel.down', 'tunnel.up']);
      expect(recordAuditEvent.mock.calls[2]?.[0].runId).not.toBe(
        recordAuditEvent.mock.calls[0]?.[0].runId,
      );

      await provider.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('jitters reconnect backoff to avoid synchronized retries', async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      const firstClose = vi.fn(async () => {});
      const secondClose = vi.fn(async () => {});
      const forward = vi
        .fn()
        .mockResolvedValueOnce({
          close: firstClose,
          url: () => 'https://first.ngrok.app',
        })
        .mockResolvedValueOnce({
          close: secondClose,
          url: () => 'https://jitter.ngrok.app',
        });
      const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
      const provider = new NgrokTunnelProvider({
        fetch,
        healthCheckIntervalMs: 100,
        loadNgrok: async () => ({ forward }),
        reconnectInitialBackoffMs: 50,
        reconnectMaxBackoffMs: 500,
        recordAuditEvent: vi.fn(),
        readSecret: () => 'test-token',
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(provider.status()).toMatchObject({
        state: 'reconnecting',
        reconnect_attempt: 1,
      });

      await vi.advanceTimersByTimeAsync(54);
      expect(forward).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(forward).toHaveBeenCalledTimes(2);
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://jitter.ngrok.app',
        state: 'up',
      });

      await provider.stop();
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it('lets a manual start replace a pending reconnect attempt', async () => {
    vi.useFakeTimers();
    try {
      const firstClose = vi.fn(async () => {});
      const secondClose = vi.fn(async () => {});
      const forward = vi
        .fn()
        .mockResolvedValueOnce({
          close: firstClose,
          url: () => 'https://first.ngrok.app',
        })
        .mockResolvedValueOnce({
          close: secondClose,
          url: () => 'https://manual.ngrok.app',
        });
      const fetch = vi.fn(async () => ({ ok: false, status: 503 }));
      const recordAuditEvent = vi.fn();
      const provider = new NgrokTunnelProvider({
        fetch,
        healthCheckIntervalMs: 100,
        loadNgrok: async () => ({ forward }),
        reconnectInitialBackoffMs: 1_000,
        reconnectMaxBackoffMs: 1_000,
        recordAuditEvent,
        readSecret: () => 'test-token',
      });

      await provider.start();
      await vi.advanceTimersByTimeAsync(100);

      expect(provider.status()).toMatchObject({
        running: false,
        state: 'reconnecting',
        reconnect_attempt: 1,
      });

      await expect(provider.start()).resolves.toEqual({
        public_url: 'https://manual.ngrok.app',
      });
      expect(forward).toHaveBeenCalledTimes(2);
      expect(provider.status()).toMatchObject({
        running: true,
        public_url: 'https://manual.ngrok.app',
        state: 'up',
        reconnect_attempt: 0,
      });
      expect(recordAuditEvent.mock.calls[2]?.[0].event).toMatchObject({
        type: 'tunnel.up',
        reason: 'manual_reconnect',
        public_url: 'https://manual.ngrok.app',
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(forward).toHaveBeenCalledTimes(2);

      await provider.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
