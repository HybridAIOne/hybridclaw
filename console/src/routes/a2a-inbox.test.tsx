import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminA2AInboxResponse } from '../api/types';
import { A2AInboxPage } from './a2a-inbox';

const fetchA2AInboxMock =
  vi.fn<
    (token: string, threadId?: string | null) => Promise<AdminA2AInboxResponse>
  >();
const useAuthMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchA2AInbox: (token: string, threadId?: string | null) =>
    fetchA2AInboxMock(token, threadId),
}));

vi.mock('../auth', () => ({
  useAuth: () => useAuthMock(),
}));

function makeResponse(selectedThreadId: string | null): AdminA2AInboxResponse {
  const selected = selectedThreadId || 'thread-new';
  return {
    selectedThreadId: selected,
    threads: [
      {
        id: 'thread-new',
        messageCount: 2,
        participants: ['main@team@local-dev', 'writer@team@local-dev'],
        latestMessage: {
          id: 'msg-new-2',
          threadId: 'thread-new',
          senderAgentId: 'writer@team@local-dev',
          recipientAgentId: 'main@team@local-dev',
          parentMessageId: 'msg-new-1',
          intent: 'handoff',
          content: 'Final handoff is ready.',
          createdAt: '2026-05-01T10:00:00.000Z',
        },
      },
      {
        id: 'thread-old',
        messageCount: 1,
        participants: ['main@team@local-dev', 'researcher@team@local-dev'],
        latestMessage: {
          id: 'msg-old-1',
          threadId: 'thread-old',
          senderAgentId: 'main@team@local-dev',
          recipientAgentId: 'researcher@team@local-dev',
          parentMessageId: null,
          intent: 'chat',
          content: 'Earlier research request.',
          createdAt: '2026-05-01T09:00:00.000Z',
        },
      },
    ],
    messages:
      selected === 'thread-old'
        ? [
            {
              id: 'msg-old-1',
              threadId: 'thread-old',
              senderAgentId: 'main@team@local-dev',
              recipientAgentId: 'researcher@team@local-dev',
              parentMessageId: null,
              intent: 'chat',
              content: 'Earlier research request.',
              createdAt: '2026-05-01T09:00:00.000Z',
            },
          ]
        : [
            {
              id: 'msg-new-1',
              threadId: 'thread-new',
              senderAgentId: 'main@team@local-dev',
              recipientAgentId: 'writer@team@local-dev',
              parentMessageId: null,
              intent: 'chat',
              content: 'Please take this task.',
              createdAt: '2026-05-01T09:45:00.000Z',
            },
            {
              id: 'msg-new-2',
              threadId: 'thread-new',
              senderAgentId: 'writer@team@local-dev',
              recipientAgentId: 'main@team@local-dev',
              parentMessageId: 'msg-new-1',
              intent: 'handoff',
              content: 'Final handoff is ready.',
              createdAt: '2026-05-01T10:00:00.000Z',
            },
          ],
  };
}

function renderA2AInboxPage(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <A2AInboxPage />
    </QueryClientProvider>,
  );
}

describe('A2AInboxPage', () => {
  beforeEach(() => {
    fetchA2AInboxMock.mockReset();
    useAuthMock.mockReset();
    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchA2AInboxMock.mockImplementation(async (_token, threadId) =>
      makeResponse(threadId || null),
    );
  });

  it('shows recent threads and opens a read-only thread view', async () => {
    renderA2AInboxPage();

    expect(await screen.findAllByText('thread-new')).not.toHaveLength(0);
    expect(screen.getAllByText('Final handoff is ready.')).not.toHaveLength(0);
    expect(screen.getByText('Please take this task.')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /reply|send|intervene/i }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /thread-old/i }));

    await waitFor(() => {
      expect(fetchA2AInboxMock).toHaveBeenLastCalledWith(
        'test-token',
        'thread-old',
      );
    });
    expect(
      await screen.findAllByText('Earlier research request.'),
    ).not.toHaveLength(0);
    expect(screen.getByText('To: researcher@team@local-dev')).toBeTruthy();
  });
});
