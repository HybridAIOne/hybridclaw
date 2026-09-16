import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdminCommandResult,
  AdminFeedbackDraft,
  AdminFeedbackDraftsResponse,
} from '../api/types';
import { renderWithProviders } from '../test-utils';
import { FeedbackPage } from './feedback';

const fetchAdminFeedbackDraftsMock =
  vi.fn<
    (
      token: string,
      params?: { status?: string; limit?: number },
    ) => Promise<AdminFeedbackDraftsResponse>
  >();
const executeCommandMock =
  vi.fn<
    (
      token: string,
      sessionId: string,
      userId: string,
      args: string[],
    ) => Promise<AdminCommandResult>
  >();
const navigateMock = vi.fn();
const useAuthMock = vi.fn();
let searchState: { tab?: string } = {};

vi.mock('../api/client', () => ({
  fetchAdminFeedbackDrafts: (
    token: string,
    params?: { status?: string; limit?: number },
  ) => fetchAdminFeedbackDraftsMock(token, params),
}));

vi.mock('../api/chat', () => ({
  executeCommand: (
    token: string,
    sessionId: string,
    userId: string,
    args: string[],
  ) => executeCommandMock(token, sessionId, userId, args),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => searchState,
}));

function makeDraft(
  overrides: Partial<AdminFeedbackDraft> = {},
): AdminFeedbackDraft {
  return {
    id: 'fbd_0123456789',
    session_id: 'session-a',
    agent_id: 'main',
    channel_id: 'web',
    run_id: 'run-1',
    model: 'gpt-5',
    provider: 'hybridai',
    gateway_version: '0.31.0',
    trigger: 'tool_error',
    type: 'bug',
    title: 'PDF skill fails on rotated pages',
    details: 'The rotate step throws on landscape pages.',
    area: 'skills/pdf',
    failure_mode: 'code_quality',
    task_category: 'debug',
    status: 'queued',
    viewed_at: null,
    submitted_by: null,
    created_at: '2026-09-15T10:00:00.000Z',
    updated_at: '2026-09-15T10:00:00.000Z',
    expires_at: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

describe('FeedbackPage', () => {
  beforeEach(() => {
    fetchAdminFeedbackDraftsMock.mockReset();
    executeCommandMock.mockReset();
    navigateMock.mockReset();
    navigateMock.mockResolvedValue(undefined);
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    searchState = {};
    localStorage.setItem('hybridclaw_user_id', 'web-user-1');
  });

  it('lists queued drafts by default with type, area, agent, model, and actions', async () => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({
      drafts: [
        makeDraft(),
        makeDraft({
          id: 'fbd_abcdefabcd',
          type: 'idea',
          title: 'Let /export pick a page range',
          area: null,
          agent_id: 'research',
          model: null,
        }),
      ],
    });

    renderWithProviders(<FeedbackPage />);

    await waitFor(() =>
      expect(
        screen.getByText('PDF skill fails on rotated pages'),
      ).not.toBeNull(),
    );
    expect(fetchAdminFeedbackDraftsMock).toHaveBeenCalledWith('test-token', {
      status: 'queued',
      limit: 100,
    });
    expect(screen.getByText('Queued drafts (2)')).not.toBeNull();

    const bugRow = screen.getByTestId('feedback-draft-fbd_0123456789');
    expect(bugRow.textContent).toContain('Bug report');
    expect(bugRow.textContent).toContain('skills/pdf');
    expect(bugRow.textContent).toContain('agent main');
    expect(bugRow.textContent).toContain('gpt-5');
    for (const label of ['View', 'Send', 'Send with transcript', 'Discard']) {
      expect(
        within(bugRow).getByRole('button', { name: label }),
      ).not.toBeNull();
    }

    const ideaRow = screen.getByTestId('feedback-draft-fbd_abcdefabcd');
    expect(ideaRow.textContent).toContain('Idea');
    expect(ideaRow.textContent).toContain('agent research');
  });

  it('expands a row to the full details and metadata', async () => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [makeDraft()] });

    renderWithProviders(<FeedbackPage />);

    const row = await screen.findByTestId('feedback-draft-fbd_0123456789');
    expect(
      screen.queryByText('The rotate step throws on landscape pages.'),
    ).toBeNull();

    fireEvent.click(within(row).getByRole('button', { name: 'Details' }));

    expect(
      screen.getByText('The rotate step throws on landscape pages.'),
    ).not.toBeNull();
    expect(row.textContent).toContain('fbd_0123456789');
    expect(row.textContent).toContain('tool_error');
    expect(row.textContent).toContain('code_quality');
    expect(row.textContent).toContain('gpt-5 (hybridai)');
    expect(row.textContent).toContain('0.31.0');
    expect(row.textContent).toContain('Not yet');
    expect(
      within(row).getByRole('button', { name: 'Hide details' }),
    ).not.toBeNull();
  });

  it('switches the status filter through the route tab', async () => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [] });

    renderWithProviders(<FeedbackPage />);

    await screen.findByText(/No queued feedback drafts/);
    fireEvent.click(screen.getByRole('tab', { name: 'Sent' }));

    expect(navigateMock).toHaveBeenCalledWith({
      to: '/admin/feedback',
      search: { tab: 'sent' },
      replace: true,
    });
  });

  it('fetches submitted drafts for the Sent tab and hides review actions', async () => {
    searchState = { tab: 'sent' };
    fetchAdminFeedbackDraftsMock.mockResolvedValue({
      drafts: [
        makeDraft({
          status: 'submitted',
          submitted_by: 'web-user-1',
          viewed_at: '2026-09-15T11:00:00.000Z',
        }),
      ],
    });

    renderWithProviders(<FeedbackPage />);

    const row = await screen.findByTestId('feedback-draft-fbd_0123456789');
    expect(fetchAdminFeedbackDraftsMock).toHaveBeenCalledWith('test-token', {
      status: 'submitted',
      limit: 100,
    });
    expect(screen.getByText('Sent drafts (1)')).not.toBeNull();
    expect(row.textContent).toContain('Sent');
    expect(within(row).queryByRole('button', { name: 'Send' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(within(row).getByRole('button', { name: 'Details' })).not.toBeNull();
  });

  it.each([
    ['discarded', 'discarded'],
    ['expired', 'expired'],
  ])('maps the %s tab to status=%s', async (tab, status) => {
    searchState = { tab };
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [] });

    renderWithProviders(<FeedbackPage />);

    await waitFor(() =>
      expect(fetchAdminFeedbackDraftsMock).toHaveBeenCalledWith('test-token', {
        status,
        limit: 100,
      }),
    );
  });

  it('sends with transcript through the command endpoint for the draft session', async () => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [makeDraft()] });
    executeCommandMock.mockResolvedValue({
      kind: 'plain',
      text: 'Sent feedback draft `fbd_0123456789` to HybridAI with the transcript excerpt.',
    });

    renderWithProviders(<FeedbackPage />);

    const row = await screen.findByTestId('feedback-draft-fbd_0123456789');
    fireEvent.click(
      within(row).getByRole('button', { name: 'Send with transcript' }),
    );

    await waitFor(() =>
      expect(executeCommandMock).toHaveBeenCalledWith(
        'test-token',
        'session-a',
        'web-user-1',
        ['feedback', 'send', 'fbd_0123456789', '--transcript'],
      ),
    );
    await waitFor(() =>
      expect(within(row).getByRole('status').textContent).toContain(
        'with the transcript excerpt',
      ),
    );
    // Successful actions refetch the list so the row leaves the Queued tab.
    await waitFor(() =>
      expect(fetchAdminFeedbackDraftsMock.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it.each([
    ['View', ['feedback', 'view', 'fbd_0123456789']],
    ['Send', ['feedback', 'send', 'fbd_0123456789']],
    ['Discard', ['feedback', 'discard', 'fbd_0123456789']],
  ])('%s runs the matching /feedback command', async (label, args) => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [makeDraft()] });
    executeCommandMock.mockResolvedValue({ kind: 'plain', text: 'ok' });

    renderWithProviders(<FeedbackPage />);

    const row = await screen.findByTestId('feedback-draft-fbd_0123456789');
    fireEvent.click(within(row).getByRole('button', { name: label }));

    await waitFor(() =>
      expect(executeCommandMock).toHaveBeenCalledWith(
        'test-token',
        'session-a',
        'web-user-1',
        args,
      ),
    );
  });

  it('shows a command error inline and keeps the row actionable', async () => {
    fetchAdminFeedbackDraftsMock.mockResolvedValue({ drafts: [makeDraft()] });
    executeCommandMock.mockResolvedValue({
      kind: 'error',
      title: 'Feedback Not Sent',
      text: 'Not signed in to HybridAI. The draft stays queued.',
    });

    renderWithProviders(<FeedbackPage />);

    const row = await screen.findByTestId('feedback-draft-fbd_0123456789');
    fireEvent.click(within(row).getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(within(row).getByRole('alert').textContent).toContain(
        'Not signed in to HybridAI.',
      ),
    );
    expect(within(row).getByRole('button', { name: 'Send' })).not.toBeNull();
    expect(fetchAdminFeedbackDraftsMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed list request', async () => {
    fetchAdminFeedbackDraftsMock.mockRejectedValue(new Error('HTTP 503'));

    renderWithProviders(<FeedbackPage />);

    await waitFor(() =>
      expect(screen.getByText(/HTTP 503/).className).toContain('error'),
    );
  });
});
