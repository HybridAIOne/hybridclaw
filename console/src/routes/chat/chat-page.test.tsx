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

import type { TestRouter } from './__test-utils/router-mock';

vi.mock('@tanstack/react-router', async () => {
  const { createRouterMock } = await import('./__test-utils/router-mock');
  return createRouterMock('session-a');
});

import type {
  BranchResponse,
  ChatContextResponse,
  ChatHistoryResponse,
  ChatMobileQrResponse,
  ChatRecentResponse,
  CommandResponse,
  MediaUploadResponse,
} from '../../api/chat-types';
import type {
  AdminModelsResponse,
  AgentListItem,
  GatewayStatus,
} from '../../api/types';
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
const fetchChatContextMock =
  vi.fn<(token: string, sessionId: string) => Promise<ChatContextResponse>>();
const createChatMobileQrMock =
  vi.fn<
    (
      token: string,
      payload: { userId: string; sessionId: string; baseUrl?: string },
    ) => Promise<ChatMobileQrResponse>
  >();
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
const executeCommandMock =
  vi.fn<
    (
      token: string,
      sessionId: string,
      userId: string,
      args: string[],
    ) => Promise<CommandResponse>
  >();
const fetchAgentListMock = vi.fn<(token: string) => Promise<AgentListItem[]>>();
const fetchModelsMock =
  vi.fn<(token: string) => Promise<AdminModelsResponse>>();
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
  fetchChatContext: (token: string, sessionId: string) =>
    fetchChatContextMock(token, sessionId),
  createChatMobileQr: (
    token: string,
    payload: { userId: string; sessionId: string; baseUrl?: string },
  ) => createChatMobileQrMock(token, payload),
  createChatBranch: (
    token: string,
    sessionId: string,
    beforeMessageId: number | string,
  ) => createChatBranchMock(token, sessionId, beforeMessageId),
  uploadMedia: (token: string, file: File) => uploadMediaMock(token, file),
  executeCommand: (
    token: string,
    sessionId: string,
    userId: string,
    args: string[],
  ) => executeCommandMock(token, sessionId, userId, args),
}));

vi.mock('../../api/client', () => ({
  fetchAgentList: (token: string) => fetchAgentListMock(token),
  fetchModels: (token: string) => fetchModelsMock(token),
}));

vi.mock('../../auth', () => ({
  isAuthReadyForApi: (auth: {
    status: string;
    token: string;
    gatewayStatus?: { webAuthConfigured?: boolean } | null;
  }) =>
    auth.status === 'ready' &&
    (auth.gatewayStatus?.webAuthConfigured !== true ||
      auth.token.trim().length > 0),
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

function ensureLocalStorage() {
  if (typeof globalThis.localStorage?.clear === 'function') return;
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  });
}

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

  beforeEach(async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    ensureLocalStorage();
    localStorage.clear();
    localStorage.setItem('hybridclaw_session', 'session-a');
    localStorage.setItem('hybridclaw_user_id', 'web-user-1');

    const routerModule = (await import(
      '@tanstack/react-router'
    )) as unknown as {
      __testRouter: TestRouter;
    };
    routerModule.__testRouter.reset();

    fetchAppStatusMock.mockReset();
    fetchChatRecentMock.mockReset();
    fetchChatHistoryMock.mockReset();
    fetchChatContextMock.mockReset();
    createChatMobileQrMock.mockReset();
    createChatBranchMock.mockReset();
    uploadMediaMock.mockReset();
    executeCommandMock.mockReset();
    fetchAgentListMock.mockReset();
    fetchModelsMock.mockReset();
    fetchModelsMock.mockResolvedValue({
      defaultModel: 'gpt-5',
      providerStatus: {},
      models: [],
    } as AdminModelsResponse);
    useAuthMock.mockReset();
    sendMessageMock.mockReset();
    stopRequestMock.mockReset();
    isActiveMock.mockReset();
    useChatStreamMock.mockReset();

    const gatewayStatus: GatewayStatus = {
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
    };
    useAuthMock.mockReturnValue({
      status: 'ready',
      token: 'test-token',
      gatewayStatus,
      error: null,
      login: vi.fn(),
      logout: vi.fn(),
      retry: vi.fn(),
    });
    fetchAppStatusMock.mockResolvedValue(gatewayStatus);
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
    fetchChatContextMock.mockResolvedValue({
      sessionId: 'session-a',
      snapshot: null,
    });
    executeCommandMock.mockResolvedValue({
      kind: 'plain',
      text: 'Session agent set to `charly` (model: `gpt-5`).',
      sessionId: 'session-a',
    });
    fetchAgentListMock.mockResolvedValue([
      { id: 'main', name: 'Assistant' },
      { id: 'charly', name: 'Charly' },
    ]);
    createChatMobileQrMock.mockResolvedValue({
      launchUrl: 'https://example.test/chat/continue?token=test-token',
      expiresAt: '2026-04-14T10:10:00.000Z',
      qrSvg: '<svg viewBox="0 0 1 1"></svg>',
    });
    isActiveMock.mockReturnValue(false);
    useChatStreamMock.mockReturnValue({
      sendMessage: sendMessageMock,
      stopRequest: stopRequestMock,
      isStreaming: false,
      streamingMsgId: null,
      isActive: isActiveMock,
    });
  });

  it('does not issue chat API queries before auth is ready', async () => {
    useAuthMock.mockReturnValue({
      status: 'checking',
      token: 'stale-token',
      gatewayStatus: null,
      error: null,
    });

    renderChatPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchAppStatusMock).not.toHaveBeenCalled();
    expect(fetchAgentListMock).not.toHaveBeenCalled();
    expect(fetchModelsMock).not.toHaveBeenCalled();
    expect(fetchChatRecentMock).not.toHaveBeenCalled();
    expect(fetchChatHistoryMock).not.toHaveBeenCalled();
    expect(fetchChatContextMock).not.toHaveBeenCalled();
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

  it('switches agents from the composer dropdown using the command path', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [{ id: 101, role: 'assistant', content: 'Opened session A' }],
    });

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();
    await waitFor(() => expect(fetchAgentListMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Switch agent'), {
      target: { value: 'charly' },
    });

    await waitFor(() =>
      expect(executeCommandMock).toHaveBeenCalledWith(
        'test-token',
        'session-a',
        'web-user-1',
        ['agent', 'switch', 'charly'],
      ),
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'Session agent set to charly',
      );
      expect(document.body.textContent).toContain('gpt-5');
    });
  });

  it('keeps first agent switch result visible when bare /chat resolves to a server session id', async () => {
    const routerModule = (await import(
      '@tanstack/react-router'
    )) as unknown as {
      __testRouter: TestRouter;
    };
    routerModule.__testRouter.setSessionId(null);
    fetchChatHistoryMock.mockImplementation(async (_token, sessionId) => ({
      sessionId,
      history: [],
    }));
    executeCommandMock.mockImplementation(
      async (_token, sessionId): Promise<CommandResponse> => ({
        kind: 'plain',
        text: 'Session agent set to `bk` (model: `openrouter/nvidia/nemotron-3-super-120b-a12b:free`).',
        sessionId,
      }),
    );

    renderChatPage();

    const agentSelect = await screen.findByLabelText('Switch agent');
    fireEvent.change(agentSelect, {
      target: { value: 'charly' },
    });

    await waitFor(() =>
      expect(routerModule.__testRouter.lastTo).toBe('/chat/$sessionId'),
    );
    expect(routerModule.__testRouter.lastReplace).toBe(true);
    expect(executeCommandMock.mock.calls[0]?.[1]).toMatch(
      /^sess_\d{8}_\d{6}_[0-9a-f]{8}$/,
    );
    await waitFor(() => {
      expect(document.body.textContent).toContain('Session agent set to bk');
      expect(document.body.textContent).toContain(
        'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
      );
    });
  });

  it('syncs the model dropdown from the session context snapshot', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [{ id: 101, role: 'assistant', content: 'Opened session A' }],
    });
    fetchModelsMock.mockResolvedValue({
      defaultModel: 'hybridai/qwen3.6-27b-fp8',
      providerStatus: {},
      models: [
        {
          id: 'hybridai/qwen3.6-27b-fp8',
          provider: 'hybridai',
          backend: null,
          contextWindow: null,
          isReasoning: false,
          family: null,
          parameterSize: null,
        },
      ],
    } as AdminModelsResponse);
    fetchChatContextMock.mockResolvedValue({
      sessionId: 'session-a',
      snapshot: {
        sessionId: 'session-a',
        model: 'hybridai/grok-4.20-0309-non-reasoning',
        contextUsedTokens: null,
        contextBudgetTokens: null,
        contextUsagePercent: null,
        contextRemainingTokens: null,
        compactionCount: 0,
        compactionTokenBudget: 0,
        compactionMessageThreshold: 0,
        compactionKeepRecent: 0,
        messageCount: 1,
        promptTokens: null,
        completionTokens: null,
      },
    });

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();
    const trigger = await screen.findByRole('combobox', {
      name: 'Switch model',
    });
    await waitFor(() =>
      expect(trigger.textContent).toContain('Grok 4.20 0309 Non Reasoning'),
    );
    expect(trigger.textContent).not.toContain('Qwen3.6 27b Fp8');
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

  it('does not refetch or clear messages when the already-active session is clicked', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [{ id: 101, role: 'assistant', content: 'Opened session A' }],
    });

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();
    const callsBefore = fetchChatHistoryMock.mock.calls.length;

    fireEvent.click(
      screen.getByText('Session A').closest('button') as HTMLButtonElement,
    );

    // Flush any pending microtasks so an erroneous refetch would have landed.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Opened session A')).not.toBeNull();
    expect(fetchChatHistoryMock.mock.calls.length).toBe(callsBefore);
  });

  it('creates a branch, prefetches its history, then sends the edited message', async () => {
    fetchChatHistoryMock.mockImplementation(
      async (_token, sessionId): Promise<ChatHistoryResponse> => ({
        sessionId,
        history:
          sessionId === 'session-branch'
            ? []
            : [{ id: 501, role: 'user', content: 'Original question' }],
      }),
    );
    createChatBranchMock.mockResolvedValue({ sessionId: 'session-branch' });

    renderChatPage();

    expect(await screen.findByText('Original question')).not.toBeNull();

    fireEvent.click(screen.getByTitle('Edit'));
    const editBox = screen.getByLabelText(
      'Edit message',
    ) as HTMLTextAreaElement;
    fireEvent.change(editBox, { target: { value: 'Edited question' } });
    expect(screen.getByDisplayValue('Edited question')).not.toBeNull();
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    expect(saveButtons).toHaveLength(1);
    fireEvent.click(saveButtons[0] as HTMLButtonElement);

    await waitFor(() =>
      expect(createChatBranchMock).toHaveBeenCalledWith(
        'test-token',
        'session-a',
        501,
      ),
    );
    await waitFor(() =>
      expect(fetchChatHistoryMock).toHaveBeenCalledWith(
        'test-token',
        'session-branch',
      ),
    );
    await waitFor(() =>
      expect(sendMessageMock).toHaveBeenCalledWith('Edited question', []),
    );

    // Branch history must resolve before the deferred sendMessage fires.
    const branchFetchIdx = fetchChatHistoryMock.mock.calls.findIndex(
      (call) => call[1] === 'session-branch',
    );
    expect(branchFetchIdx).toBeGreaterThanOrEqual(0);
    const branchFetchOrder =
      fetchChatHistoryMock.mock.invocationCallOrder[branchFetchIdx];
    const sendOrder = sendMessageMock.mock.invocationCallOrder[0];
    expect(branchFetchOrder).toBeLessThan(sendOrder);
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

  it('seeds gateway status from auth without refetching it', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
    });

    renderChatPage();

    expect(await screen.findByText('Ready to claw through your to-do list?'));
    expect(fetchAppStatusMock).not.toHaveBeenCalled();
  });

  it('collapses to the icon rail and exposes an Expand trigger that re-opens it', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
    });

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1440,
    });

    renderChatPage();

    await waitFor(() => expect(fetchChatHistoryMock).toHaveBeenCalled());

    const aside = document.querySelector('aside[data-side="left"]');
    expect(aside?.getAttribute('data-state')).toBe('expanded');

    const collapseTrigger = within(aside as HTMLElement).getByRole('button', {
      name: 'Collapse sidebar',
    });
    fireEvent.click(collapseTrigger);
    expect(aside?.getAttribute('data-state')).toBe('collapsed');

    const expandTrigger = within(aside as HTMLElement).getByRole('button', {
      name: 'Expand sidebar',
    });
    expect(aside?.contains(expandTrigger)).toBe(true);
    fireEvent.click(expandTrigger);
    expect(aside?.getAttribute('data-state')).toBe('expanded');
  });

  it('surfaces a sidebar trigger in the chat topbar only on mobile viewports', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
    });

    function openTriggersInChatTopbar() {
      const topbar = document.querySelector('[class*="chatTopbar"]');
      if (!topbar) return 0;
      return topbar.querySelectorAll('button[aria-label="Open sidebar"]')
        .length;
    }

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 800,
    });

    renderChatPage();

    await waitFor(() => expect(fetchChatHistoryMock).toHaveBeenCalled());
    expect(openTriggersInChatTopbar()).toBe(1);

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1440,
      });
      window.dispatchEvent(new Event('resize'));
    });

    expect(openTriggersInChatTopbar()).toBe(0);
  });

  it('refreshes recent sessions when the mobile sidebar opens', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [],
    });

    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 800,
    });

    renderChatPage();

    await waitFor(() => expect(fetchChatRecentMock).toHaveBeenCalledTimes(1));

    const topbar = document.querySelector('[class*="chatTopbar"]');
    if (!(topbar instanceof HTMLElement)) {
      throw new Error('Missing chat topbar');
    }

    fireEvent.click(
      within(topbar).getByRole('button', { name: 'Open sidebar' }),
    );

    await waitFor(() => expect(fetchChatRecentMock).toHaveBeenCalledTimes(2));
  });

  it('creates a mobile handoff QR code for the active chat session', async () => {
    fetchChatHistoryMock.mockResolvedValue({
      sessionId: 'session-a',
      history: [{ id: 101, role: 'assistant', content: 'Opened session A' }],
    });

    renderChatPage();

    expect(await screen.findByText('Opened session A')).not.toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Show mobile QR code' }),
    );

    await waitFor(() =>
      expect(createChatMobileQrMock).toHaveBeenCalledWith('test-token', {
        userId: 'web-user-1',
        sessionId: 'session-a',
        baseUrl: 'http://localhost:3000',
      }),
    );
    expect(await screen.findByText('Open on mobile')).not.toBeNull();
    expect(screen.getByText('Open link')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close mobile QR code' })).toBe(
      document.activeElement,
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(screen.queryByText('Open on mobile')).toBeNull(),
    );
  });
});
