import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminOverview,
  AdminTunnelConfigResponse,
  AdminTunnelStatus,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { DashboardPage } from './dashboard';

const fetchOverviewMock = vi.fn();
const fetchStatisticsMock = vi.fn();
const fetchTunnelConfigMock = vi.fn();
const reconnectTunnelMock = vi.fn();
const saveTunnelConfigMock = vi.fn();
const stopTunnelMock = vi.fn();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
const useLiveEventsMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchOverview: (...args: unknown[]) => fetchOverviewMock(...args),
  fetchStatistics: (...args: unknown[]) => fetchStatisticsMock(...args),
  fetchTunnelConfig: (...args: unknown[]) => fetchTunnelConfigMock(...args),
  reconnectTunnel: (...args: unknown[]) => reconnectTunnelMock(...args),
  saveTunnelConfig: (...args: unknown[]) => saveTunnelConfigMock(...args),
  stopTunnel: (...args: unknown[]) => stopTunnelMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../hooks/use-live-events', () => ({
  useLiveEvents: (...args: unknown[]) => useLiveEventsMock(...args),
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

function makeOverview(
  tunnel: AdminTunnelStatus = makeTunnelStatus(),
): AdminOverview {
  return {
    status: {
      status: 'ok',
      webAuthConfigured: true,
      version: '0.12.6',
      imageTag: null,
      uptime: 120,
      sessions: 2,
      activeContainers: 1,
      defaultAgentId: 'main',
      defaultModel: 'gpt-5',
      ragDefault: true,
      timestamp: '2026-04-29T10:00:00.000Z',
      providerHealth: {},
      scheduler: { jobs: [] },
    },
    configPath: '/tmp/config.json',
    tunnel,
    recentSessions: [],
    usage: {
      daily: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      monthly: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      topModels: [],
    },
  };
}

function makeTunnelConfigResponse(
  overrides: Partial<AdminTunnelConfigResponse['config']> = {},
): AdminTunnelConfigResponse {
  return {
    config: {
      mode: 'local',
      provider: 'manual',
      publicUrl: '',
      healthCheckIntervalMs: 30_000,
      ...overrides,
    },
    tunnel: makeTunnelStatus({
      provider: overrides.provider ?? 'manual',
      publicUrl: overrides.publicUrl || null,
      reconnectSupported:
        overrides.provider === 'ngrok' ||
        overrides.provider === 'tailscale' ||
        overrides.provider === 'cloudflare',
    }),
  };
}

function renderDashboardPage(): void {
  renderWithProviders(<DashboardPage />);
}

describe('DashboardPage', () => {
  beforeEach(() => {
    fetchOverviewMock.mockReset();
    fetchStatisticsMock.mockReset();
    fetchStatisticsMock.mockResolvedValue({
      rangeDays: 30,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      totals: {
        newSessions: 0,
        activeSessions: 0,
        totalMessages: 0,
        userMessages: 0,
        assistantMessages: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        callCount: 0,
        totalToolCalls: 0,
      },
      trend: [],
      channels: [],
    });
    fetchTunnelConfigMock.mockReset();
    fetchTunnelConfigMock.mockResolvedValue(makeTunnelConfigResponse());
    reconnectTunnelMock.mockReset();
    saveTunnelConfigMock.mockReset();
    saveTunnelConfigMock.mockImplementation(
      (_token: string, payload: AdminTunnelConfigResponse['config']) =>
        Promise.resolve(makeTunnelConfigResponse(payload)),
    );
    stopTunnelMock.mockReset();
    navigateMock.mockReset();
    useAuthMock.mockReset();
    useLiveEventsMock.mockReset();

    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: null,
    });
    useLiveEventsMock.mockReturnValue({
      connection: 'open',
      overview: null,
      status: null,
      lastEventAt: Date.now(),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows public tunnel provider, URL, and reconnecting status', async () => {
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          health: 'reconnecting',
          state: 'reconnecting',
          nextReconnectAt: '2026-04-29T10:01:00.000Z',
        }),
      ),
    );

    renderDashboardPage();

    expect(
      await screen.findByRole('heading', { name: 'Public tunnel' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'https://public.example.test' })
        .getAttribute('href'),
    ).toBe('https://public.example.test');
    expect(screen.getAllByText('ngrok').length).toBeGreaterThan(0);
    expect(screen.getByText('reconnecting')).toBeTruthy();
  });

  it('calls the reconnect endpoint and updates the public URL', async () => {
    fetchOverviewMock.mockResolvedValue(makeOverview());
    reconnectTunnelMock.mockResolvedValue(
      makeTunnelStatus({ publicUrl: 'https://next.example.test' }),
    );

    renderDashboardPage();

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

  it('saves a manually started public tunnel URL from the dashboard', async () => {
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          provider: 'manual',
          publicUrl: null,
          state: 'down',
          health: 'down',
          reconnectSupported: false,
        }),
      ),
    );

    renderDashboardPage();

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
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          provider: 'manual',
          publicUrl: null,
          state: 'down',
          health: 'down',
          reconnectSupported: false,
        }),
      ),
    );

    renderDashboardPage();

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
    fetchOverviewMock.mockResolvedValue(makeOverview());

    renderDashboardPage();

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

  it('saves managed ngrok config and starts the tunnel from the dashboard', async () => {
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          provider: 'manual',
          publicUrl: 'https://old.ngrok-free.dev',
          reconnectSupported: false,
        }),
      ),
    );
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

    renderDashboardPage();

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

  it('shows stop for a running managed tunnel and stops it from the dashboard', async () => {
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          provider: 'ngrok',
          publicUrl: 'https://running.ngrok-free.dev',
          state: 'up',
          health: 'healthy',
          reconnectSupported: true,
        }),
      ),
    );
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({
        provider: 'ngrok',
        publicUrl: '',
      }),
    );
    stopTunnelMock.mockResolvedValue(
      makeTunnelStatus({
        provider: 'ngrok',
        publicUrl: null,
        state: 'down',
        health: 'down',
        reconnectSupported: true,
      }),
    );

    renderDashboardPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => {
      expect(stopTunnelMock).toHaveBeenCalledWith('test-token');
    });
    expect(await screen.findByText('not configured')).toBeTruthy();
  });

  it('shows a spinner action while a managed tunnel is starting', async () => {
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          provider: 'ngrok',
          publicUrl: null,
          state: 'starting',
          health: 'reconnecting',
          reconnectSupported: true,
        }),
      ),
    );
    fetchTunnelConfigMock.mockResolvedValue(
      makeTunnelConfigResponse({
        provider: 'ngrok',
        publicUrl: '',
      }),
    );

    renderDashboardPage();

    const button = await screen.findByRole('button', { name: 'Starting' });

    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.button-spinner')).toBeTruthy();
  });

  it('does not repeat the same tunnel and reconnect error', async () => {
    const message =
      'ngrok auth token is not configured in encrypted runtime secrets. Store it with `hybridclaw secret set NGROK_AUTHTOKEN <token>` or in TUI with `/secret set NGROK_AUTHTOKEN <token>`.';
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          publicUrl: null,
          state: 'down',
          health: 'down',
          lastError: message,
          lastCheckedAt: null,
        }),
      ),
    );
    reconnectTunnelMock.mockRejectedValue(new Error(` ${message} `));

    renderDashboardPage();

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
    fetchOverviewMock.mockResolvedValue(
      makeOverview(
        makeTunnelStatus({
          publicUrl: null,
          state: 'down',
          health: 'down',
          lastError: tunnelError,
          lastCheckedAt: null,
        }),
      ),
    );
    reconnectTunnelMock.mockRejectedValue(new Error(reconnectError));

    renderDashboardPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

    await waitFor(() => {
      expect(reconnectTunnelMock).toHaveBeenCalledWith('test-token');
      expect(screen.getByText(tunnelError)).toBeTruthy();
      expect(screen.getByText(reconnectError)).toBeTruthy();
    });
  });

  it('keeps zero daily usage and per-day chart labels visible', async () => {
    const overview = makeOverview();
    overview.usage.monthly = {
      totalInputTokens: 800,
      totalOutputTokens: 400,
      totalTokens: 1200,
      totalCostUsd: 0.05,
      callCount: 3,
      totalToolCalls: 1,
    };
    fetchOverviewMock.mockResolvedValue(overview);
    fetchStatisticsMock.mockResolvedValue({
      rangeDays: 30,
      startDate: '2026-04-29',
      endDate: '2026-04-30',
      totals: {
        newSessions: 0,
        activeSessions: 0,
        totalMessages: 0,
        userMessages: 0,
        assistantMessages: 0,
        totalInputTokens: 800,
        totalOutputTokens: 400,
        totalTokens: 1200,
        totalCostUsd: 0.05,
        callCount: 3,
        totalToolCalls: 1,
      },
      trend: [
        {
          date: '2026-04-29',
          newSessions: 0,
          activeSessions: 0,
          userMessages: 0,
          assistantMessages: 0,
          totalMessages: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          callCount: 0,
          toolCalls: 0,
          costUsd: 0,
        },
        {
          date: '2026-04-30',
          newSessions: 0,
          activeSessions: 0,
          userMessages: 0,
          assistantMessages: 0,
          totalMessages: 0,
          inputTokens: 800,
          outputTokens: 400,
          totalTokens: 1200,
          callCount: 3,
          toolCalls: 1,
          costUsd: 0.05,
        },
      ],
      channels: [],
    });

    renderDashboardPage();

    expect(
      await screen.findByText((content) =>
        content.includes('tokens this month · 0 today'),
      ),
    ).toBeTruthy();
    expect(await screen.findByText('Apr 29: 0 tokens')).toBeTruthy();
    expect(await screen.findByText('Apr 30: 1.2K tokens')).toBeTruthy();
  });
});
