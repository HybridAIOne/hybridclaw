import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminOverview, AdminTunnelStatus } from '../api/types';
import { DashboardPage } from './dashboard';

const fetchOverviewMock = vi.fn();
const reconnectTunnelMock = vi.fn();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
const useLiveEventsMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchOverview: (...args: unknown[]) => fetchOverviewMock(...args),
  reconnectTunnel: (...args: unknown[]) => reconnectTunnelMock(...args),
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

function renderDashboardPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    fetchOverviewMock.mockReset();
    reconnectTunnelMock.mockReset();
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
    expect(screen.getByText('ngrok')).toBeTruthy();
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

  it('does not repeat the same tunnel and reconnect error', async () => {
    const message =
      'ngrok auth token is not configured in encrypted runtime secrets. Store it with `hybridclaw secret set NGROK_AUTHTOKEN <token>`.';
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
});
