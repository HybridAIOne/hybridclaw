import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentsOverviewResponse } from '../api/types';
import { AgentsOverviewPage } from './agents-overview';

const fetchAgentsOverviewMock = vi.fn<() => Promise<AgentsOverviewResponse>>();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchAgentsOverview: () => fetchAgentsOverviewMock(),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
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
    useAuthMock.mockReset();
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

    fireEvent.click(screen.getByRole('button', { name: 'Stopped' }));

    expect(screen.queryByText('Session A')).toBeNull();
    expect(screen.getByText('Session B')).toBeTruthy();
  });

  it('opens a selected session in the chat route', async () => {
    renderAgentsOverviewPage();

    await waitFor(() => {
      expect(screen.getByText('Session A')).toBeTruthy();
    });

    const sessionCard = screen.getByText('Session A').closest('article');
    expect(sessionCard).not.toBeNull();

    fireEvent.click(
      within(sessionCard as HTMLElement).getByRole('button', {
        name: 'Open Chat',
      }),
    );

    expect(localStorage.getItem('hybridclaw_session')).toBe('session-a');
    expect(navigateMock).toHaveBeenCalledWith({ to: '/chat' });
  });
});
