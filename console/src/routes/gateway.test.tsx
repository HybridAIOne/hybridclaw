import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatewayPage } from './gateway';

const restartGatewayMock = vi.fn();
const validateTokenMock = vi.fn();
const useAuthMock = vi.fn();
const useLiveEventsMock = vi.fn();

vi.mock('../api/client', () => ({
  restartGateway: (...args: unknown[]) => restartGatewayMock(...args),
  validateToken: (...args: unknown[]) => validateTokenMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

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
      <GatewayPage />
    </QueryClientProvider>,
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('GatewayPage', () => {
  beforeEach(() => {
    restartGatewayMock.mockReset();
    validateTokenMock.mockReset();
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
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('disables restart when the gateway lifecycle does not support it', () => {
    useAuthMock.mockReturnValue({
      token: 'test-token',
      gatewayStatus: makeStatus({
        lifecycle: {
          restartSupported: false,
          restartReason: 'Gateway restart is unavailable in this launch mode.',
        },
      }),
    });

    renderGatewayPage();

    const button = screen.getByRole('button', {
      name: 'Restart Gateway',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain('danger-button');
    expect(
      screen.queryByText('Gateway restart is unavailable in this launch mode.'),
    ).not.toBeNull();
  });

  it('shows a restarting spinner until the status poll succeeds', async () => {
    vi.useFakeTimers();
    restartGatewayMock.mockResolvedValue({
      status: 'ok',
      message: 'Gateway restart requested.',
    });
    validateTokenMock.mockResolvedValue(
      makeStatus({
        pid: 5678,
        timestamp: '2026-04-09T12:05:00.000Z',
      }),
    );

    renderGatewayPage();
    fireEvent.click(screen.getByRole('button', { name: 'Restart Gateway' }));
    await act(async () => {
      await flushMicrotasks();
    });

    expect(restartGatewayMock).toHaveBeenCalledWith('test-token');
    expect(
      screen.queryByRole('button', { name: 'Restarting Gateway' }),
    ).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushMicrotasks();
    });

    expect(validateTokenMock).toHaveBeenCalledWith('test-token');
    expect(
      screen.queryByRole('button', { name: 'Restart Gateway' }),
    ).not.toBeNull();
    vi.useRealTimers();
  });
});
