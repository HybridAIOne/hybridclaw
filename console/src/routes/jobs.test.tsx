import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminSchedulerJob,
  AdminSchedulerResponse,
  JobSession,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { JobsPage } from './jobs';

const fetchBoardBudgetSummariesMock = vi.fn();
const fetchJobsContextMock = vi.fn();
const fetchSchedulerMock = vi.fn<() => Promise<AdminSchedulerResponse>>();
const moveSchedulerJobMock = vi.fn();
const navigateMock = vi.fn();
const resumeInteractiveEscalationMock = vi.fn();
const saveSchedulerJobMock = vi.fn();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchBoardBudgetSummaries: (...args: unknown[]) =>
    fetchBoardBudgetSummariesMock(...args),
  fetchJobsContext: (...args: unknown[]) => fetchJobsContextMock(...args),
  fetchScheduler: () => fetchSchedulerMock(),
  moveSchedulerJob: (...args: unknown[]) => moveSchedulerJobMock(...args),
  resumeInteractiveEscalation: (...args: unknown[]) =>
    resumeInteractiveEscalationMock(...args),
  saveSchedulerJob: (...args: unknown[]) => saveSchedulerJobMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

function makeConfigJob(
  overrides: Partial<AdminSchedulerJob> = {},
): AdminSchedulerJob {
  return {
    id: 'release-reminder',
    source: 'job',
    name: 'Release Reminder',
    description: 'Send the release reminder.',
    agentId: 'main',
    boardStatus: 'review',
    maxRetries: null,
    enabled: true,
    schedule: {
      kind: 'one_shot',
      at: null,
      everyMs: null,
      expr: null,
      tz: 'Europe/Berlin',
    },
    action: {
      kind: 'system_event',
      message: 'Release in 10 minutes.',
    },
    delivery: {
      kind: 'channel',
      channel: 'tui',
      to: 'tui',
      webhookUrl: '',
    },
    lastRun: '2026-04-12T18:44:15.000Z',
    lastStatus: 'success',
    nextRunAt: null,
    disabled: false,
    consecutiveErrors: 0,
    createdAt: null,
    sessionId: null,
    channelId: 'tui',
    taskId: null,
    ...overrides,
  };
}

function makeJobSession(overrides: Partial<JobSession> = {}): JobSession {
  return {
    sessionId: 'scheduler:release-reminder',
    agentId: 'main',
    startedAt: '2026-04-12T18:40:00.000Z',
    lastActive: '2026-04-12T18:44:15.000Z',
    status: 'stopped',
    lastAnswer: 'Release in 10 minutes.',
    output: ['Release in 10 minutes.'],
    ...overrides,
  };
}

function renderJobsPage(): void {
  renderWithProviders(<JobsPage />);
}

describe('JobsPage', () => {
  beforeEach(() => {
    fetchJobsContextMock.mockReset();
    fetchBoardBudgetSummariesMock.mockReset();
    fetchSchedulerMock.mockReset();
    moveSchedulerJobMock.mockReset();
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    resumeInteractiveEscalationMock.mockReset();
    saveSchedulerJobMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({
      token: 'test-token',
    });
    fetchJobsContextMock.mockResolvedValue({
      agents: [{ id: 'main', name: 'Main' }],
      sessions: [],
      suspendedSessions: [],
    });
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    fetchBoardBudgetSummariesMock.mockResolvedValue({
      budgets: [],
    });
    resumeInteractiveEscalationMock.mockResolvedValue({
      session: {
        sessionId: 'session-2fa',
        status: 'resumed',
        modality: 'sms',
      },
      response: { kind: 'code', value: '123456' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the sent system event text when there is no scheduler session', async () => {
    renderJobsPage();

    await waitFor(() => {
      expect(screen.getByText('Release Reminder')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Release Reminder'));

    await waitFor(() => {
      expect(screen.getAllByText('Release in 10 minutes.').length).toBe(2);
    });
    expect(screen.getByText('Outputs')).toBeTruthy();
    expect(
      screen.queryByText('No outputs captured for this job yet.'),
    ).toBeNull();
    expect(screen.queryByText('Created')).toBeNull();
    expect(screen.queryByText('never')).toBeNull();
  });

  it('renders budget chips with threshold and currency formatting', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [
        makeConfigJob({
          id: 'neutral-job',
          name: 'Neutral Budget',
          agentId: 'main',
        }),
        makeConfigJob({
          id: 'warn-job',
          name: 'Warn Budget',
          agentId: 'agent-warn',
        }),
        makeConfigJob({
          id: 'hard-job',
          name: 'Hard Budget',
          agentId: 'agent-hard',
        }),
        makeConfigJob({
          id: 'no-budget-job',
          name: 'No Budget',
          agentId: 'agent-no-budget',
        }),
      ],
    });
    fetchJobsContextMock.mockResolvedValue({
      agents: [
        { id: 'main', name: 'Main' },
        { id: 'agent-warn', name: 'Warn' },
        { id: 'agent-hard', name: 'Hard' },
        { id: 'agent-no-budget', name: 'No Budget Agent' },
      ],
      sessions: [],
      suspendedSessions: [],
    });
    fetchBoardBudgetSummariesMock.mockResolvedValue({
      budgets: [
        {
          agentId: 'main',
          used: 3.4,
          cap: 60,
          currency: 'USD',
          percent: 79.5,
        },
        {
          agentId: 'agent-warn',
          used: 81,
          cap: 100,
          currency: 'USD',
          percent: 99.5,
        },
        {
          agentId: 'agent-hard',
          used: 12,
          cap: 10,
          currency: 'EUR',
          percent: 120,
        },
      ],
    });

    renderJobsPage();

    const neutral = await screen.findByText('$3.40 / $60');
    const warn = await screen.findByText('$81 / $100');
    const hard = await screen.findByText('€12 / €10');

    expect(neutral.getAttribute('data-tone')).toBe('neutral');
    expect(neutral.getAttribute('title')).toBe('79% used');
    const neutralAgentRow = neutral.closest('.jobs-card-agent-row');
    expect(neutralAgentRow).not.toBeNull();
    expect(
      within(neutralAgentRow as HTMLElement).getByText('Main'),
    ).toBeTruthy();
    expect(warn.getAttribute('data-tone')).toBe('warn');
    expect(warn.getAttribute('title')).toBe('99% used');
    const warnAgentRow = warn.closest('.jobs-card-agent-row');
    expect(warnAgentRow).not.toBeNull();
    expect(within(warnAgentRow as HTMLElement).getByText('Warn')).toBeTruthy();
    expect(hard.getAttribute('data-tone')).toBe('hard');
    expect(hard.getAttribute('title')).toBe('120% used');
    const hardAgentRow = hard.closest('.jobs-card-agent-row');
    expect(hardAgentRow).not.toBeNull();
    expect(within(hardAgentRow as HTMLElement).getByText('Hard')).toBeTruthy();
    expect(screen.queryByText('$0 / $0')).toBeNull();
  });

  it('uses the linked session start time as the created timestamp', async () => {
    fetchJobsContextMock.mockResolvedValue({
      agents: [{ id: 'main', name: 'Main' }],
      sessions: [makeJobSession()],
      suspendedSessions: [],
    });
    fetchSchedulerMock.mockResolvedValue({
      jobs: [
        makeConfigJob({
          action: {
            kind: 'agent_turn',
            message: 'Draft the release reminder.',
          },
          lastStatus: 'success',
          sessionId: 'scheduler:release-reminder',
        }),
      ],
    });

    renderJobsPage();

    await waitFor(() => {
      expect(screen.getByText('Release Reminder')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Release Reminder'));

    await waitFor(() => {
      expect(screen.getByText('Created')).toBeTruthy();
    });
    expect(screen.queryByText('never')).toBeNull();
  });

  it('opens the scheduler editor with SPA navigation', async () => {
    renderJobsPage();

    await waitFor(() => {
      expect(screen.getByText('Release Reminder')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Release Reminder'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/scheduler',
      search: { jobId: 'release-reminder' },
    });
  });

  it('shows blocked sessions on the board and resumes them from the detail pane', async () => {
    fetchJobsContextMock.mockResolvedValue({
      agents: [{ id: 'main', name: 'Main' }],
      sessions: [],
      suspendedSessions: [
        {
          sessionId: 'session-2fa',
          agentId: 'main',
          approvalId: 'approval-2fa',
          userId: 'operator-1',
          prompt: 'Enter the SMS verification code.',
          status: 'pending',
          modality: 'sms',
          expectedReturnKinds: ['code', 'declined', 'timeout'],
          context: {
            host: 'sap.example',
            pageTitle: 'Verify sign in',
            url: 'https://sap.example/login',
          },
          createdAt: '2026-04-12T18:40:00.000Z',
          expiresAt: '2026-04-12T18:50:00.000Z',
          blockedLabel: 'Blocked: sms',
        },
      ],
    });

    renderJobsPage();

    await waitFor(() => {
      expect(screen.getAllByText('Blocked: sms').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getAllByText('Blocked: sms')[0]);
    fireEvent.change(screen.getByLabelText('Code for session-2fa'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(resumeInteractiveEscalationMock).toHaveBeenCalledWith(
        'test-token',
        {
          sessionId: 'session-2fa',
          response: { kind: 'code', value: '123456' },
        },
      );
    });
  });
});
