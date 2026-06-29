import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentsOverviewResponse } from '../api/types';
import { AgentsOverviewPage } from './agents-overview';

const fetchAgentsOverviewMock = vi.fn<() => Promise<AgentsOverviewResponse>>();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
const useConfiguredViewSwitchItemsMock = vi.hoisted(() => vi.fn());
const ViewSwitchNavMock = vi.hoisted(() => vi.fn());

function ensureLocalStorage() {
  if (typeof globalThis.localStorage?.clear === 'function') return;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
    },
  });
}

vi.mock('../api/client', () => ({
  fetchAgentsOverview: () => fetchAgentsOverviewMock(),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../components/view-switch', () => ({
  useConfiguredViewSwitchItems: (token: string) =>
    useConfiguredViewSwitchItemsMock(token),
  ViewSwitchNav: (props: { items?: unknown }) => {
    ViewSwitchNavMock(props);
    return <nav data-testid="view-switch" />;
  },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to: string;
    className?: string;
    children: ReactNode;
  }) => (
    <a data-router-link="true" href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => navigateMock,
  useRouterState: (params: {
    select: (state: { location: { pathname: string } }) => string;
  }) => params.select({ location: { pathname: '/agents' } }),
}));

function makeOverview(): AgentsOverviewResponse {
  return {
    generatedAt: '2026-05-15T10:00:00.000Z',
    version: '0.19.2',
    uptime: 3600,
    ralph: {
      enabled: true,
      maxIterations: 5,
    },
    totals: {
      agents: {
        all: 1,
        active: 1,
        idle: 0,
        stopped: 0,
        unused: 0,
        running: 1,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        totalCostUsd: 0.12,
      },
      sessions: {
        all: 2,
        active: 1,
        idle: 0,
        stopped: 1,
        running: 1,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        totalCostUsd: 0.12,
      },
    },
    agents: [
      {
        id: 'main',
        name: 'Main',
        model: 'gpt-5',
        chatbotId: 'support',
        enableRag: true,
        workspace: null,
        workspacePath: '/tmp/main',
        sessionCount: 2,
        activeSessions: 1,
        idleSessions: 0,
        stoppedSessions: 1,
        effectiveModels: ['gpt-5'],
        lastActive: '2026-05-15T09:58:00.000Z',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.12,
        messageCount: 4,
        toolCalls: 2,
        recentSessionId: 'session-a',
        status: 'active',
        monthlySpendUsd: 0.12,
      },
    ],
    sessions: [
      {
        id: 'session-a',
        name: 'Session A',
        task: 'Draft update',
        lastQuestion: 'Can you draft an update?',
        lastAnswer: 'Draft ready.',
        fullAutoEnabled: false,
        model: 'gpt-5',
        sessionId: 'session-a',
        channelId: 'web',
        channelName: 'Web',
        agentId: 'main',
        startedAt: '2026-05-15T09:45:00.000Z',
        lastActive: '2026-05-15T09:58:00.000Z',
        runtimeMinutes: 12,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.12,
        messageCount: 4,
        toolCalls: 2,
        status: 'active',
        watcher: 'running',
        previewTitle: 'Recent',
        previewMeta: 'meta',
        output: ['$ echo hi', 'success'],
      },
      {
        id: 'session-b',
        name: 'Session B',
        task: 'Archive report',
        lastQuestion: null,
        lastAnswer: null,
        fullAutoEnabled: false,
        model: 'gpt-5',
        sessionId: 'session-b',
        channelId: 'discord',
        channelName: null,
        agentId: 'main',
        startedAt: '2026-05-15T08:00:00.000Z',
        lastActive: '2026-05-15T08:05:00.000Z',
        runtimeMinutes: 5,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        messageCount: 0,
        toolCalls: 0,
        status: 'stopped',
        watcher: 'stopped',
        previewTitle: 'Stopped',
        previewMeta: null,
        output: [],
      },
    ],
  };
}

function renderAgentsOverviewPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AgentsOverviewPage />
    </QueryClientProvider>,
  );
}

describe('AgentsOverviewPage', () => {
  beforeEach(() => {
    fetchAgentsOverviewMock.mockReset();
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    useAuthMock.mockReset();
    useConfiguredViewSwitchItemsMock.mockReset();
    useConfiguredViewSwitchItemsMock.mockReturnValue([
      { href: '/chat', label: 'Chat' },
      {
        href: 'https://hybridai.one/admin_startpage',
        image: '/icons/hybridai.png',
        label: 'HybridAI',
      },
    ]);
    ViewSwitchNavMock.mockReset();
    ensureLocalStorage();
    localStorage.clear();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAgentsOverviewMock.mockResolvedValue(makeOverview());
  });

  it('renders registered agents and filters sessions without leaving the SPA', async () => {
    renderAgentsOverviewPage();

    await waitFor(() => {
      expect(screen.getByText('Registered Agents')).toBeTruthy();
    });

    expect(screen.getByText('Main')).toBeTruthy();
    expect(screen.getByText('Session A')).toBeTruthy();
    expect(screen.getByText('Session B')).toBeTruthy();
    expect(useConfiguredViewSwitchItemsMock).toHaveBeenCalledWith('test-token');
    expect(ViewSwitchNavMock).toHaveBeenCalledWith({
      items: [
        { href: '/chat', label: 'Chat' },
        {
          href: 'https://hybridai.one/admin_startpage',
          image: '/icons/hybridai.png',
          label: 'HybridAI',
        },
      ],
    });

    fireEvent.click(screen.getByRole('tab', { name: /Stopped/ }));

    expect(screen.queryByText('Session A')).toBeNull();
    expect(screen.getByText('Session B')).toBeTruthy();
  });

  it('keeps session actions focused on admin inspection', async () => {
    renderAgentsOverviewPage();

    await waitFor(() => {
      expect(screen.getByText('Session A')).toBeTruthy();
    });

    const sessionCard = screen.getByText('Session A').closest('article');
    expect(sessionCard).not.toBeNull();

    expect(
      within(sessionCard as HTMLElement).queryByRole('button', {
        name: 'Open Chat',
      }),
    ).toBeNull();

    fireEvent.click(
      within(sessionCard as HTMLElement).getByRole('button', {
        name: 'Open Session',
      }),
    );

    expect(localStorage.getItem('hybridclaw_session')).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/sessions',
      search: { sessionId: 'session-a' },
    });
  });
});
