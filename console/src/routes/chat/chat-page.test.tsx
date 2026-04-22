import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BranchResponse,
  ChatHistoryResponse,
  ChatRecentResponse,
  MediaUploadResponse,
} from '../../api/chat-types';
import type { GatewayStatus } from '../../api/types';
import { SidebarProvider } from '../../components/sidebar/index';
import { ChatPage } from './chat-page';

const fetchAppStatusMock = vi.fn<(token: string) => Promise<GatewayStatus>>();
const fetchChatRecentMock =
  vi.fn<
    (
      token: string,
      userId: string,
      channelId?: string,
      limit?: number,
      query?: string,
    ) => Promise<ChatRecentResponse>
  >();
const fetchChatHistoryMock =
  vi.fn<(token: string, sessionId: string) => Promise<ChatHistoryResponse>>();
const createChatBranchMock =
  vi.fn<
    (
      token: string,
      sessionId: string,
      beforeMessageId: number | string,
    ) => Promise<BranchResponse>
  >();
const uploadMediaMock =
  vi.fn<(token: string, file: File) => Promise<MediaUploadResponse>>();
const useAuthMock = vi.fn();
const sendMessageMock = vi.fn();
const stopRequestMock = vi.fn();
const isActiveMock = vi.fn();
const useChatStreamMock = vi.fn();

vi.mock('../../api/chat', () => ({
  fetchAppStatus: (token: string) => fetchAppStatusMock(token),
  fetchChatRecent: (
    token: string,
    userId: string,
    channelId?: string,
    limit?: number,
    query?: string,
  ) => fetchChatRecentMock(token, userId, channelId, limit, query),
  fetchChatHistory: (token: string, sessionId: string) =>
    fetchChatHistoryMock(token, sessionId),
  createChatBranch: (
    token: string,
    sessionId: string,
    beforeMessageId: number | string,
  ) => createChatBranchMock(token, sessionId, beforeMessageId),
  uploadMedia: (token: string, file: File) => uploadMediaMock(token, file),
}));

vi.mock('../../auth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('./use-chat-stream', () => ({
  useChatStream: (...args: unknown[]) => useChatStreamMock(...args),
}));

vi.mock('../../components/view-switch', () => ({
  ViewSwitchNav: () => null,
}));

vi.mock('../../components/theme-toggle', () => ({
  ThemeToggle: () => null,
}));

function renderChatPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <Suspense fallback={<div>Loading chat…</div>}>
          <ChatPage />
        </Suspense>
      </SidebarProvider>
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('ChatPage', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    localStorage.clear();
    localStorage.setItem('hybridclaw_session', 'session-a');
    localStorage.setItem('hybridclaw_user_id', 'web-user-1');

    fetchAppStatusMock.mockReset();
    fetchChatRecentMock.mockReset();
    fetchChatHistoryMock.mockReset();
    createChatBranchMock.mockReset();
    uploadMediaMock.mockReset();
    useAuthMock.mockReset();
    sendMessageMock.mockReset();
    stopRequestMock.mockReset();
    isActiveMock.mockReset();
    useChatStreamMock.mockReset();

    useAuthMock.mockReturnValue({ token: 'test-token' });
    fetchAppStatusMock.mockResolvedValue({
      status: 'ok',
      webAuthConfigured: true,
      version: '0.0.0',
      imageTag: null,
      uptime: 0,
      sessions: 0,
      activeContainers: 0,
      defaultAgentId: 'main',
      defaultModel: 'gpt-5',
      ragDefault: false,
      timestamp: '2026-04-14T10:00:00.000Z',
    });
    fetchChatRecentMock.mockImplementation(
      async (_token, _userId, _channelId, _limit, query) => ({
        sessions: query
          ? [
              {
                sessionId: 'session-search',
                title: 'Deployment checklist',
                searchSnippet: '...deployment rollback steps from yesterday...',
                lastActive: '2026-04-13T09:30:00.000Z',
                messageCount: 4,
              },
            ]
          : [
              {
                sessionId: 'session-a',
                title: 'Session A',
                lastActive: '2026-04-14T10:00:00.000Z',
                messageCount: 2,
              },
              {
                sessionId: 'session-b',
                title: 'Session B',
                lastActive: '2026-04-14T09:30:00.000Z',
                messageCount: 3,
              },
            ],
      }),
    );
    isActiveMock.mockReturnValue(false);
    useChatStreamMock.mockReturnValue({
      sendMessage: sendMessageMock,
      stopRequest: stopRequestMock,
      isStreaming: false,
      streamingMsgId: null,
      isActive: isActiveMock,
    });
  });

  it('loads history, sends from the composer, and switches recent sessions', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history:
          sessionId === 'session-b'
            ? [
                {
                  id: 201,
                  role: 'assistant',
                  content: 'Opened session B',
                },
              ]
            : [
                {
                  id: 101,
                  role: 'assistant',
                  content: 'Opened session A',
                },
              ],
      }),
    );

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();

    const input = screen.getByLabelText('Message input');
    fireEvent.input(input, { target: { value: 'hello from web chat' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith('hello from web chat', []),
    );

    fireEvent.click(
      screen.getByText('Session B').closest('button') as HTMLButtonElement,
    );

    expect(await screen.findByText('Opened session B')).not.toBeNull();
    await waitFor(() =>
      expect(fetchChatHistoryMock).toHaveBeenCalledWith(
        'test-token',
        'session-b',
      ),
    );
  });

  it('reuses cached history when switching back to a recent session inside the stale window', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history: [
          {
            id: sessionId === 'session-b' ? 201 : 101,
            role: 'assistant',
            content:
              sessionId === 'session-b'
                ? 'Opened session B'
                : 'Opened session A',
          },
        ],
      }),
    );

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();

    fireEvent.click(
      screen.getByText('Session B').closest('button') as HTMLButtonElement,
    );
    expect(await screen.findByText('Opened session B')).not.toBeNull();

    fireEvent.click(
      screen.getByText('Session A').closest('button') as HTMLButtonElement,
    );
    expect(await screen.findByText('Opened session A')).not.toBeNull();

    expect(fetchChatHistoryMock).toHaveBeenCalledTimes(2);
    expect(fetchChatHistoryMock.mock.calls).toEqual([
      ['test-token', 'session-a'],
      ['test-token', 'session-b'],
    ]);
  });

  it('assigns branch controls to loaded history and opens sibling branches', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history: [
          {
            id: 42,
            role: 'assistant',
            content:
              sessionId === 'session-b'
                ? 'Alternate assistant reply'
                : 'Primary assistant reply',
          },
        ],
        branchFamilies: [
          {
            anchorSessionId: 'session-a',
            anchorMessageId: 42,
            variants: [
              { sessionId: 'session-a', messageId: 42 },
              { sessionId: 'session-b', messageId: 42 },
            ],
          },
        ],
      }),
    );

    renderChatPage();

    const initialCounter = await screen.findByText('1/2');
    const initialActions = initialCounter.parentElement;
    if (!(initialActions instanceof HTMLElement)) {
      throw new Error('Missing branch action container');
    }

    fireEvent.click(
      within(initialActions).getByRole('button', { name: 'Next branch' }),
    );

    expect(await screen.findByText('Alternate assistant reply')).not.toBeNull();
    expect(await screen.findByText('2/2')).not.toBeNull();
    await waitFor(() =>
      expect(fetchChatHistoryMock).toHaveBeenCalledWith(
        'test-token',
        'session-b',
      ),
    );
  });

  it('searches conversation titles beyond the default recent list', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history: [
          {
            id: sessionId === 'session-search' ? 301 : 101,
            role: 'assistant',
            content:
              sessionId === 'session-search'
                ? 'Opened deployment thread'
                : 'Opened session A',
          },
        ],
      }),
    );

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Search conversations'), {
      target: { value: 'deploy' },
    });

    expect(await screen.findByText('Deployment checklist')).not.toBeNull();
    expect(
      await screen.findByText('...deployment rollback steps from yesterday...'),
    ).not.toBeNull();
    await waitFor(() =>
      expect(fetchChatRecentMock).toHaveBeenCalledWith(
        'test-token',
        'web-user-1',
        'web',
        50,
        'deploy',
      ),
    );

    fireEvent.click(
      screen
        .getByText('Deployment checklist')
        .closest('button') as HTMLButtonElement,
    );

    expect(await screen.findByText('Opened deployment thread')).not.toBeNull();
    await waitFor(() =>
      expect(fetchChatHistoryMock).toHaveBeenCalledWith(
        'test-token',
        'session-search',
      ),
    );
  });

  it('renders title-only search matches without a snippet', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history: [
          {
            id: sessionId === 'session-title-only' ? 401 : 101,
            role: 'assistant',
            content:
              sessionId === 'session-title-only'
                ? 'Opened title-only deployment thread'
                : 'Opened session A',
          },
        ],
      }),
    );
    fetchChatRecentMock.mockImplementation(
      async (_token, _userId, _channelId, _limit, query) => ({
        sessions: query
          ? [
              {
                sessionId: 'session-title-only',
                title: 'Deployment checklist',
                lastActive: '2026-04-13T09:30:00.000Z',
                messageCount: 1,
              },
            ]
          : [
              {
                sessionId: 'session-a',
                title: 'Session A',
                lastActive: '2026-04-14T10:00:00.000Z',
                messageCount: 2,
              },
            ],
      }),
    );

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Search conversations'), {
      target: { value: 'deploy' },
    });

    expect(await screen.findByText('Deployment checklist')).not.toBeNull();
    expect(
      screen.queryByText('...deployment rollback steps from yesterday...'),
    ).toBeNull();
  });

  it('debounces recent-session searches while typing', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [
        {
          id: 101,
          role: 'assistant',
          content: 'Opened session A',
        },
      ],
    });

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();
    expect(fetchChatRecentMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    const searchInput = screen.getByLabelText('Search conversations');
    for (const value of ['d', 'de', 'dep', 'depl', 'deplo', 'deploy']) {
      fireEvent.change(searchInput, { target: { value } });
    }

    expect(fetchChatRecentMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(159);
    });
    expect(fetchChatRecentMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    vi.useRealTimers();

    await waitFor(() => expect(fetchChatRecentMock).toHaveBeenCalledTimes(2));
    expect(fetchChatRecentMock).toHaveBeenLastCalledWith(
      'test-token',
      'web-user-1',
      'web',
      50,
      'deploy',
    );
  });

  it('shows an error and keeps edit mode open when the message cannot be branched', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [
        {
          role: 'user',
          content: 'Draft message without server id',
        },
      ],
    });

    renderChatPage();

    expect(
      await screen.findByText('Draft message without server id'),
    ).not.toBeNull();

    fireEvent.click(screen.getByTitle('Edit'));

    const editBox = screen.getAllByRole('textbox')[1] as HTMLTextAreaElement;
    fireEvent.change(editBox, {
      target: { value: 'Updated draft message' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(createChatBranchMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText('This message cannot be edited right now.'),
    ).not.toBeNull();
    expect(screen.getByDisplayValue('Updated draft message')).not.toBeNull();
  });

  it('surfaces gateway status load failures instead of swallowing them', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchAppStatusMock.mockRejectedValue(new Error('Gateway offline'));
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
    });

    renderChatPage();

    expect(
      await screen.findByText(
        'Failed to load the default agent. New chats will use main until gateway status loads.',
      ),
    ).not.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to load gateway status for chat page',
      expect.any(Error),
    );

    errorSpy.mockRestore();
  });
});
