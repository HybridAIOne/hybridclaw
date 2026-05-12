import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/toast';

import { GatewayPage } from './gateway';

const reloadGatewayMock = vi.fn();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
const useLiveEventsMock = vi.fn();

vi.mock('../api/client', () => ({
  reloadGateway: (...args: unknown[]) => reloadGatewayMock(...args),
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

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ok' as const,
    webAuthConfigured: true,
    pid: 1234,
    version: '0.9.7',
    imageTag: null,
    uptime: 120,
    sessions: 3,
    activeContainers: 1,
    defaultModel: 'gpt-5',
    ragDefault: true,
    timestamp: '2026-04-09T12:00:00.000Z',
    lifecycle: {
      restartSupported: true,
      restartReason: null,
    },
    providerHealth: {},
    scheduler: { jobs: [] },
    sandbox: {
      mode: 'container' as const,
      activeSessions: 1,
      warning: null,
    },
    codex: {
      authenticated: true,
      source: 'browser-pkce' as const,
      accountId: 'acct',
      expiresAt: null,
      reloginRequired: false,
    },
    observability: {
      enabled: false,
      running: false,
      paused: false,
      reason: null,
      streamKey: null,
      lastCursor: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
    },
    ...overrides,
  };
}

function renderGatewayPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <GatewayPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('GatewayPage', () => {
  beforeEach(() => {
    reloadGatewayMock.mockReset();
    navigateMock.mockReset();
    useAuthMock.mockReset();
    useLiveEventsMock.mockReset();

    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: makeStatus(),
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

  it('opens a reload confirmation dialog and calls the reload endpoint', async () => {
    reloadGatewayMock.mockResolvedValue({
      status: 'ok',
      message: 'Gateway reloaded.',
    });

    renderGatewayPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Gateway' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));

    await waitFor(() => {
      expect(reloadGatewayMock).toHaveBeenCalledWith('test-token');
    });
  });
});
