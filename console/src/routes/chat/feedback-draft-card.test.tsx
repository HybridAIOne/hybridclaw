import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatFeedbackDraft } from '../../api/chat-types';
import type { AdminCommandResult } from '../../api/types';
import { FeedbackDraftCard } from './feedback-draft-card';

const executeCommandMock =
  vi.fn<
    (
      token: string,
      sessionId: string,
      userId: string,
      args: string[],
    ) => Promise<AdminCommandResult>
  >();

vi.mock('../../api/chat', () => ({
  executeCommand: (
    token: string,
    sessionId: string,
    userId: string,
    args: string[],
  ) => executeCommandMock(token, sessionId, userId, args),
}));

const DRAFT: ChatFeedbackDraft = {
  draftId: 'fbd_0123456789',
  type: 'bug',
  title: 'PDF skill fails on rotated pages',
  trigger: 'tool_error',
};

function renderCard(draft: ChatFeedbackDraft = DRAFT) {
  return render(
    <FeedbackDraftCard
      draft={draft}
      sessionId="session-a"
      token="test-token"
    />,
  );
}

describe('FeedbackDraftCard', () => {
  beforeEach(() => {
    executeCommandMock.mockReset();
    localStorage.setItem('hybridclaw_user_id', 'web-user-1');
  });

  it('renders the queued draft with type badge, title, note, and four actions', () => {
    renderCard();

    expect(screen.getByText('Feedback draft queued')).not.toBeNull();
    expect(screen.getByText('Bug report')).not.toBeNull();
    expect(screen.getByText('PDF skill fails on rotated pages')).not.toBeNull();
    expect(
      screen.getByText('Stays on this gateway until you send it.'),
    ).not.toBeNull();
    for (const label of ['View', 'Send', 'Send with transcript', 'Discard']) {
      expect(screen.getByRole('button', { name: label })).not.toBeNull();
    }
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('labels idea and missing-capability drafts', () => {
    renderCard({ ...DRAFT, type: 'missing_capability' });
    expect(screen.getByText('Missing capability')).not.toBeNull();
  });

  it('runs `feedback view` and shows the returned text inline, keeping the buttons', async () => {
    executeCommandMock.mockResolvedValue({
      kind: 'info',
      title: 'Feedback Draft fbd_0123456789',
      text: '**PDF skill fails on rotated pages**\n\nThe rotate step throws.\n\nType: bug',
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    await waitFor(() =>
      expect(screen.getByText('The rotate step throws.')).not.toBeNull(),
    );
    expect(executeCommandMock).toHaveBeenCalledWith(
      'test-token',
      'session-a',
      'web-user-1',
      ['feedback', 'view', 'fbd_0123456789'],
    );
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Discard' })).not.toBeNull();
  });

  it('sends the draft and replaces the buttons with the result and a Sent badge', async () => {
    executeCommandMock.mockResolvedValue({
      kind: 'plain',
      text: 'Sent feedback draft `fbd_0123456789` to HybridAI without a transcript.',
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByText('Sent')).not.toBeNull());
    expect(executeCommandMock).toHaveBeenCalledWith(
      'test-token',
      'session-a',
      'web-user-1',
      ['feedback', 'send', 'fbd_0123456789'],
    );
    expect(
      screen.getByText(
        'Sent feedback draft `fbd_0123456789` to HybridAI without a transcript.',
      ),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(
      screen.queryByText('Stays on this gateway until you send it.'),
    ).toBeNull();
  });

  it('passes --transcript for "Send with transcript"', async () => {
    executeCommandMock.mockResolvedValue({
      kind: 'plain',
      text: 'Sent feedback draft `fbd_0123456789` to HybridAI with the transcript excerpt.',
    });
    renderCard();

    fireEvent.click(
      screen.getByRole('button', { name: 'Send with transcript' }),
    );

    await waitFor(() => expect(screen.getByText('Sent')).not.toBeNull());
    expect(executeCommandMock).toHaveBeenCalledWith(
      'test-token',
      'session-a',
      'web-user-1',
      ['feedback', 'send', 'fbd_0123456789', '--transcript'],
    );
  });

  it('discards the draft and shows a Discarded badge', async () => {
    executeCommandMock.mockResolvedValue({
      kind: 'plain',
      text: 'Discarded feedback draft `fbd_0123456789`. Nothing was sent.',
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(screen.getByText('Discarded')).not.toBeNull());
    expect(executeCommandMock).toHaveBeenCalledWith(
      'test-token',
      'session-a',
      'web-user-1',
      ['feedback', 'discard', 'fbd_0123456789'],
    );
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('shows a command error inline and keeps the draft actionable', async () => {
    executeCommandMock.mockResolvedValue({
      kind: 'error',
      title: 'Feedback Not Sent',
      text: 'Not signed in to HybridAI. The draft stays queued.',
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Not signed in to HybridAI.',
      ),
    );
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeNull();
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('shows a transport failure inline', async () => {
    executeCommandMock.mockRejectedValue(new Error('Gateway unreachable'));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Gateway unreachable',
      ),
    );
    expect(screen.getByRole('button', { name: 'Discard' })).not.toBeNull();
  });
});
