import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminTunnelConfigResponse,
  AdminTunnelStatus,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { TunnelSettings } from './tunnel-settings';

const fetchTunnelConfigMock = vi.fn();
const reconnectTunnelMock = vi.fn();
const saveTunnelConfigMock = vi.fn();
const stopTunnelMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchTunnelConfig: (...args: unknown[]) => fetchTunnelConfigMock(...args),
  reconnectTunnel: (...args: unknown[]) => reconnectTunnelMock(...args),
  saveTunnelConfig: (...args: unknown[]) => saveTunnelConfigMock(...args),
  stopTunnel: (...args: unknown[]) => stopTunnelMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeTunnelStatus(
  overrides: Partial<AdminTunnelStatus> = {},
): AdminTunnelStatus {
  return {
    provider: 'ngrok',
    publicUrl: 'https://public.example.test',
    state: 'up',
    health: 'healthy',
    reconnectSupported: true,
    lastError: null,
    lastCheckedAt: '2026-04-29T10:00:00.000Z',
    nextReconnectAt: null,
    ...overrides,
  };
}

function makeTunnelConfigResponse(
  overrides: Partial<AdminTunnelConfigResponse['config']> = {},
  tunnelOverrides: Partial<AdminTunnelStatus> = {},
): AdminTunnelConfigResponse {
  const provider = overrides.provider ?? 'manual';
  return {
    config: {
      mode: 'local',
      provider,
      publicUrl: '',
      healthCheckIntervalMs: 30_000,
      ...overrides,
    },
    tunnel: makeTunnelStatus({
      provider,
      publicUrl: overrides.publicUrl || null,
      state: 'down',
      health: 'down',
      reconnectSupported:
        provider === 'ngrok' ||
        provider === 'tailscale' ||
        provider === 'cloudflare',
      ...tunnelOverrides,
    }),
  };
}

function renderTunnelSettings(): void {
  renderWithProviders(<TunnelSettings />);
}

describe('TunnelSettings', () => {
  beforeEach(() => {
    fetchTunnelConfigMock.mockReset();
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: 'https://public.example.test',
          state: 'up',
          health: 'healthy',
        },
      ),
    );
    reconnectTunnelMock.mockReset();
    saveTunnelConfigMock.mockReset();
    saveTunnelConfigMock.mockImplementation(
      (_token: string, payload: AdminTunnelConfigResponse['config']) =>
        Promise.resolve(makeTunnelConfigResponse(payload)),
    );
    stopTunnelMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the configured provider, URL, and reconnecting status', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: 'https://public.example.test',
          state: 'reconnecting',
          health: 'reconnecting',
          nextReconnectAt: '2026-04-29T10:01:00.000Z',
        },
      ),
    );

    renderTunnelSettings();

    expect(
      await screen.findByRole('heading', { name: 'Public tunnel' }),
    ).toBeTruthy();
    expect(fetchTunnelConfigMock).toHaveBeenCalledWith('test-token');
    expect(
      screen
        .getByRole('link', { name: 'https://public.example.test' })
        .getAttribute('href'),
    ).toBe('https://public.example.test');
    expect(screen.getAllByText('ngrok').length).toBeGreaterThan(0);
    expect(screen.getByText('reconnecting')).toBeTruthy();
  });

  it('calls the reconnect endpoint and updates the public URL', async () => {
    reconnectTunnelMock.mockResolvedValue(
      makeTunnelStatus({ publicUrl: 'https://next.example.test' }),
    );

    renderTunnelSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(reconnectTunnelMock).toHaveBeenCalledWith('test-token');
    });
    expect(
      (
        await screen.findByRole('link', {
          name: 'https://next.example.test',
        })
      ).getAttribute('href'),
    ).toBe('https://next.example.test');
  });

  it('saves a manually started public tunnel URL', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({ provider: 'manual' }),
    );

    renderTunnelSettings();
    fireEvent.change(await screen.findByLabelText('Public URL'), {
      target: {
        value: 'https://unreinforced-ching-asthmatically.ngrok-free.dev',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(saveTunnelConfigMock).toHaveBeenCalledWith('test-token', {
        provider: 'manual',
        publicUrl: 'https://unreinforced-ching-asthmatically.ngrok-free.dev',
      });
    });
    expect(reconnectTunnelMock).not.toHaveBeenCalled();
  });

  it('disables saving invalid public tunnel URLs', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({ provider: 'manual' }),
    );

    renderTunnelSettings();
    fireEvent.change(await screen.findByLabelText('Public URL'), {
      target: { value: 'not a url' },
    });

    expect(
      await screen.findByText('Public URL must be a valid URL.'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(saveTunnelConfigMock).not.toHaveBeenCalled();
  });

  it('warns when the configured public tunnel URL uses HTTP', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({ provider: 'manual' }),
    );

    renderTunnelSettings();
    fireEvent.change(await screen.findByLabelText('Public URL'), {
      target: { value: 'http://public.example.test' },
    });

    expect(
      await screen.findByText(
        'Public tunnel URL uses HTTP. HTTPS is recommended.',
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it('saves managed ngrok config and starts the tunnel', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({
        provider: 'manual',
        publicUrl: 'https://old.ngrok-free.dev',
      }),
    );
    reconnectTunnelMock.mockResolvedValue(
      makeTunnelStatus({
        provider: 'ngrok',
        publicUrl: 'https://next.ngrok-free.dev',
      }),
    );

    renderTunnelSettings();
    fireEvent.change(await screen.findByLabelText('Provider'), {
      target: { value: 'ngrok' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & start' }));

    await waitFor(() => {
      expect(saveTunnelConfigMock).toHaveBeenCalledWith('test-token', {
        provider: 'ngrok',
        publicUrl: '',
      });
      expect(reconnectTunnelMock).toHaveBeenCalledWith('test-token');
    });
    expect(
      (
        await screen.findByRole('link', {
          name: 'https://next.ngrok-free.dev',
        })
      ).getAttribute('href'),
    ).toBe('https://next.ngrok-free.dev');
  });

  it('stops a running managed tunnel', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: 'https://running.ngrok-free.dev',
          state: 'up',
          health: 'healthy',
        },
      ),
    );
    stopTunnelMock.mockResolvedValue(
      makeTunnelStatus({
        provider: 'ngrok',
        publicUrl: null,
        state: 'down',
        health: 'down',
      }),
    );

    renderTunnelSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(stopTunnelMock).toHaveBeenCalledWith('test-token');
    });
    expect(await screen.findByText('not configured')).toBeTruthy();
  });

  it('shows a spinner action while a managed tunnel is starting', async () => {
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: null,
          state: 'starting',
          health: 'reconnecting',
        },
      ),
    );

    renderTunnelSettings();

    const button = await screen.findByRole('button', { name: 'Starting' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.button-spinner')).toBeTruthy();
  });

  it('does not repeat the same tunnel and reconnect error', async () => {
    const message =
      'ngrok auth token is not configured in encrypted runtime secrets.';
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: null,
          state: 'down',
          health: 'down',
          lastError: message,
          lastCheckedAt: null,
        },
      ),
    );
    reconnectTunnelMock.mockRejectedValue(new Error(` ${message} `));

    renderTunnelSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(reconnectTunnelMock).toHaveBeenCalledWith('test-token');
      expect(screen.getAllByText(message)).toHaveLength(1);
    });
  });

  it('shows distinct tunnel and reconnect errors', async () => {
    const tunnelError =
      'ngrok auth token is not configured in encrypted runtime secrets.';
    const reconnectError = 'Failed to start ngrok tunnel.';
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse(
        { provider: 'ngrok' },
        {
          publicUrl: null,
          state: 'down',
          health: 'down',
          lastError: tunnelError,
          lastCheckedAt: null,
        },
      ),
    );
    reconnectTunnelMock.mockRejectedValue(new Error(reconnectError));

    renderTunnelSettings();
    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(reconnectTunnelMock).toHaveBeenCalledWith('test-token');
      expect(screen.getByText(tunnelError)).toBeTruthy();
      expect(screen.getByText(reconnectError)).toBeTruthy();
    });
  });
});
