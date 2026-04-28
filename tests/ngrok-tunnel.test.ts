import { describe, expect, it, vi } from 'vitest';

import { NgrokTunnelProvider } from '../src/tunnel/ngrok-tunnel-provider.js';

describe('NgrokTunnelProvider', () => {
  it('opens an ngrok tunnel with the encrypted runtime secret token', async () => {
    const close = vi.fn(async () => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => 'https://abc123.ngrok.app/',
    }));
    const provider = new NgrokTunnelProvider({
      addr: 9090,
      loadNgrok: async () => ({ forward }),
      readSecret: (secretName) =>
        secretName === 'NGROK_AUTHTOKEN' ? ' test-token ' : null,
    });

    expect(provider.status()).toEqual({
      running: false,
      public_url: null,
    });

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
    });

    await provider.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(provider.status()).toEqual({
      running: false,
      public_url: null,
    });
  });

  it('does not load ngrok when the auth token is missing', async () => {
    const loadNgrok = vi.fn();
    const provider = new NgrokTunnelProvider({
      loadNgrok,
      readSecret: () => null,
    });

    await expect(provider.start()).rejects.toThrow('NGROK_AUTHTOKEN');
    expect(loadNgrok).not.toHaveBeenCalled();
  });

  it('returns the existing tunnel when start is called while running', async () => {
    const close = vi.fn(async () => {});
    const forward = vi.fn(async () => ({
      close,
      url: () => 'https://stable.ngrok.app',
    }));
    const provider = new NgrokTunnelProvider({
      loadNgrok: async () => ({ forward }),
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
      readSecret: () => 'test-token',
    });

    try {
      await provider.start();
      await expect(provider.stop()).resolves.toBeUndefined();

      expect(close).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[tunnel] failed to stop ngrok tunnel cleanly; local tunnel state was cleared.',
      );
      expect(provider.status()).toEqual({
        running: false,
        public_url: null,
      });
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
    const provider = new NgrokTunnelProvider({
      loadNgrok: async () => ({ forward }),
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
    expect(provider.status()).toEqual({
      running: false,
      public_url: null,
    });
  });
});
