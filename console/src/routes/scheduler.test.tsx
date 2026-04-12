import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSchedulerJob, AdminSchedulerResponse } from '../api/types';
import { normalizeSchedulerAtInput, SchedulerPage } from './scheduler';

const fetchSchedulerMock = vi.fn<() => Promise<AdminSchedulerResponse>>();
const saveSchedulerJobMock = vi.fn();
const deleteSchedulerJobMock = vi.fn();
const setSchedulerJobPausedMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchScheduler: () => fetchSchedulerMock(),
  saveSchedulerJob: (...args: unknown[]) => saveSchedulerJobMock(...args),
  deleteSchedulerJob: (...args: unknown[]) => deleteSchedulerJobMock(...args),
  setSchedulerJobPaused: (...args: unknown[]) =>
    setSchedulerJobPausedMock(...args),
}));

vi.mock('../auth', () => ({
  useAuth: () => ({
    token: 'test-token',
  }),
}));

function makeConfigJob(
  overrides: Partial<AdminSchedulerJob> = {},
): AdminSchedulerJob {
  return {
    id: 'release-notes',
    source: 'config',
    name: 'Release Notes',
    description: 'Draft release notes once.',
    agentId: 'main',
    boardStatus: 'backlog',
    maxRetries: null,
    enabled: true,
    schedule: {
      kind: 'cron',
      at: null,
      everyMs: null,
      expr: '0 * * * *',
      tz: 'Europe/Berlin',
    },
    action: {
      kind: 'agent_turn',
      message: 'Draft release notes.',
    },
    delivery: {
      kind: 'channel',
      channel: 'tui',
      to: 'tui',
      webhookUrl: '',
    },
    lastRun: null,
    lastStatus: null,
    nextRunAt: '2026-04-07T20:00:00.000Z',
    disabled: false,
    consecutiveErrors: 0,
    createdAt: null,
    sessionId: null,
    channelId: null,
    taskId: null,
    ...overrides,
  };
}

function renderSchedulerPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SchedulerPage />
    </QueryClientProvider>,
  );
}

describe('SchedulerPage', () => {
  beforeEach(() => {
    fetchSchedulerMock.mockReset();
    saveSchedulerJobMock.mockReset();
    deleteSchedulerJobMock.mockReset();
    setSchedulerJobPausedMock.mockReset();
    window.history.replaceState({}, '', '/admin/scheduler');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the selected job from the jobId query parameter', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Release Notes',
    );
    expect(
      (screen.getByLabelText('Message') as HTMLTextAreaElement).value,
    ).toBe('Draft release notes.');
  });

  it('normalizes datetime-local input before saving at schedules', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    saveSchedulerJobMock.mockImplementation(
      () => new Promise<AdminSchedulerResponse>(() => {}),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'at' },
    });
    fireEvent.change(screen.getByLabelText('Run at'), {
      target: { value: '2026-04-07T22:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).toHaveBeenCalledTimes(1);
    });

    expect(saveSchedulerJobMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        id: 'release-notes',
        schedule: expect.objectContaining({
          kind: 'at',
          at: normalizeSchedulerAtInput('2026-04-07T22:00'),
        }),
      }),
    );
  });

  it('saves one-shot jobs with the configured retry count', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    saveSchedulerJobMock.mockImplementation(
      () => new Promise<AdminSchedulerResponse>(() => {}),
    );
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'one_shot' },
    });
    fireEvent.change(screen.getByLabelText('Retries after failure'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).toHaveBeenCalledTimes(1);
    });

    expect(saveSchedulerJobMock).toHaveBeenCalledWith(
      'test-token',
      expect.objectContaining({
        id: 'release-notes',
        boardStatus: 'backlog',
        maxRetries: 5,
        schedule: expect.objectContaining({
          kind: 'one_shot',
          at: null,
        }),
      }),
    );
  });

  it('rejects one-shot retry counts above the backend limit', async () => {
    fetchSchedulerMock.mockResolvedValue({
      jobs: [makeConfigJob()],
    });
    window.history.replaceState({}, '', '/admin/scheduler?jobId=release-notes');

    renderSchedulerPage();

    await waitFor(() => {
      expect((screen.getByLabelText('ID') as HTMLInputElement).value).toBe(
        'release-notes',
      );
    });

    fireEvent.change(screen.getByLabelText('Schedule'), {
      target: { value: 'one_shot' },
    });
    fireEvent.change(screen.getByLabelText('Retries after failure'), {
      target: { value: '101' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => {
      expect(saveSchedulerJobMock).not.toHaveBeenCalled();
      expect(
        screen.getByText('Pick a valid retry count from 0 to 100.'),
      ).toBeTruthy();
    });
  });
});
