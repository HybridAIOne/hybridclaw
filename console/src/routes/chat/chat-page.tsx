import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChatBranch,
  createChatMobileQr,
  executeCommand,
  fetchAppStatus,
  fetchChatContext,
  fetchChatRecent,
  uploadMedia,
} from '../../api/chat';
import type {
  BranchVariant,
  ChatMessage,
  ChatMobileQrResponse,
  MediaItem,
} from '../../api/chat-types';
import { fetchAgentList, fetchModels } from '../../api/client';
import type { ChatModel } from '../../api/types';
import { isAuthReadyForApi, useAuth } from '../../auth';
import { MobileTopbarTrigger } from '../../components/sidebar/index';
import { ViewSwitchNav } from '../../components/view-switch';
import {
  type ApprovalAction,
  buildApprovalCommand,
  copyToClipboard,
  DEFAULT_AGENT_ID,
  isScrolledNearBottom,
  nextMsgId,
  readStoredUserId,
} from '../../lib/chat-helpers';
import { CHAT_UI_CONFIG } from '../../lib/chat-ui-config';
import { getErrorMessage } from '../../lib/error-message';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import {
  type ChatHistoryUiData,
  chatHistoryQueryKey,
  EMPTY_BRANCH_FAMILIES,
  loadChatHistoryUi,
} from './chat-history-query';
import css from './chat-page.module.css';
import { ChatSidebarPanel, ChatSidebarProvider } from './chat-sidebar';
import type { ChatUiMessage } from './chat-ui-message';
import { Composer } from './composer';
import { ContextRing } from './context-ring';
import { EditInline, MessageBlock } from './message-block';
import { useChatSession } from './use-chat-session';
import { useChatStream } from './use-chat-stream';

type BranchInfo = {
  current: number;
  total: number;
};

const EMPTY_MESSAGES: ChatUiMessage[] = [];
const EMPTY_MODELS: ChatModel[] = [];

function buildBranchInfoMap(
  messages: ChatUiMessage[],
  branchFamilies: Map<string, BranchVariant[]>,
): Map<string, BranchInfo> {
  const map = new Map<string, BranchInfo>();
  if (branchFamilies.size === 0) return map;
  for (const msg of messages) {
    const key = msg.branchKey;
    if (!key) continue;
    const variants = branchFamilies.get(key);
    if (!variants || variants.length < 2) continue;
    const currentIdx = variants.findIndex(
      (variant) => variant.sessionId === msg.sessionId,
    );
    if (currentIdx < 0) continue;
    map.set(msg.id, {
      current: currentIdx + 1,
      total: variants.length,
    });
  }
  return map;
}

export function ChatPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const userId = useRef(readStoredUserId()).current;
  const defaultAgentIdRef = useRef(DEFAULT_AGENT_ID);

  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [mobileQr, setMobileQr] = useState<ChatMobileQrResponse | null>(null);
  const [mobileQrBusy, setMobileQrBusy] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(
    defaultAgentIdRef.current,
  );
  const [selectedModelId, setSelectedModelId] = useState('');

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const debouncedSessionSearchQuery = useDebouncedValue(
    sessionSearchQuery,
    160,
  );
  const trimmedSessionSearchQuery = debouncedSessionSearchQuery.trim();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const mobileQrDialogRef = useRef<HTMLDivElement>(null);
  const mobileQrCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const setVisualViewportHeight = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      document.documentElement.style.setProperty(
        '--chat-visual-viewport-height',
        `${Math.round(height)}px`,
      );
      document.scrollingElement?.scrollTo({ left: 0 });
      document.body.scrollLeft = 0;
      document.documentElement.scrollLeft = 0;
    };
    setVisualViewportHeight();
    window.addEventListener('resize', setVisualViewportHeight);
    window.addEventListener('orientationchange', setVisualViewportHeight);
    window.visualViewport?.addEventListener('resize', setVisualViewportHeight);
    window.visualViewport?.addEventListener('scroll', setVisualViewportHeight);
    return () => {
      window.removeEventListener('resize', setVisualViewportHeight);
      window.removeEventListener('orientationchange', setVisualViewportHeight);
      window.visualViewport?.removeEventListener(
        'resize',
        setVisualViewportHeight,
      );
      window.visualViewport?.removeEventListener(
        'scroll',
        setVisualViewportHeight,
      );
      document.documentElement.style.removeProperty(
        '--chat-visual-viewport-height',
      );
    };
  }, []);

  const getDefaultAgentId = useCallback(() => defaultAgentIdRef.current, []);
  const {
    sessionId,
    getSessionId,
    navigateToSession,
    switchToSession,
    startFreshChat,
    ensureSessionForSend,
    handleSessionIdCorrection,
  } = useChatSession({ getDefaultAgentId });

  const refreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['chat-recent', auth.token, userId],
    });
    void queryClient.invalidateQueries({
      queryKey: chatHistoryQueryKey(auth.token, getSessionId()),
      refetchType: 'none',
    });
  }, [queryClient, auth.token, userId, getSessionId]);

  const stream = useChatStream({
    token: auth.token,
    userId,
    getSessionId,
    setError,
    refreshRecent,
    onSessionIdCorrection: handleSessionIdCorrection,
    onModelResolved: setSelectedModelId,
  });
  const chatApiReady = isAuthReadyForApi(auth);

  const appStatusQuery = useQuery({
    queryKey: ['app-status', auth.token],
    queryFn: () => fetchAppStatus(auth.token),
    staleTime: Infinity,
    enabled: chatApiReady,
    initialData:
      auth.status === 'ready' && auth.gatewayStatus
        ? auth.gatewayStatus
        : undefined,
  });

  const agentsQuery = useQuery({
    queryKey: ['agents-list', auth.token],
    queryFn: () => fetchAgentList(auth.token),
    staleTime: 30_000,
    enabled: chatApiReady,
  });

  const modelsQuery = useQuery({
    queryKey: ['models', auth.token],
    queryFn: () => fetchModels(auth.token),
    staleTime: 30_000,
    enabled: chatApiReady,
  });

  useEffect(() => {
    const id = appStatusQuery.data?.defaultAgentId;
    if (id) {
      const normalized = id.trim().toLowerCase();
      defaultAgentIdRef.current = normalized;
      setSelectedAgentId((current) =>
        !current || current === DEFAULT_AGENT_ID ? normalized : current,
      );
    }
  }, [appStatusQuery.data?.defaultAgentId]);

  // /model set is session-scoped on the gateway, so re-seed the local selection
  // to the gateway default whenever the session changes. We don't know what
  // model the new session was last set to, so the default is the best guess
  // until the user picks again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is intentionally a re-fire trigger, not read inside the body
  useEffect(() => {
    const id = appStatusQuery.data?.defaultModel?.trim() ?? '';
    setSelectedModelId(id);
  }, [sessionId, appStatusQuery.data?.defaultModel]);

  useEffect(() => {
    if (!appStatusQuery.error) return;
    console.error(
      'Failed to load gateway status for chat page',
      appStatusQuery.error,
    );
    setError(
      'Failed to load the default agent. New chats will use main until gateway status loads.',
    );
  }, [appStatusQuery.error]);

  useEffect(() => {
    if (!modelsQuery.error) return;
    console.error(
      'Failed to load models list for chat page',
      modelsQuery.error,
    );
    setError('Failed to load the model list. Model switching is unavailable.');
  }, [modelsQuery.error]);

  const recentQuery = useQuery({
    queryKey: ['chat-recent', auth.token, userId, trimmedSessionSearchQuery],
    queryFn: () =>
      fetchChatRecent(
        auth.token,
        userId,
        'web',
        trimmedSessionSearchQuery
          ? CHAT_UI_CONFIG.maxSearchResults
          : CHAT_UI_CONFIG.maxRecentSessions,
        trimmedSessionSearchQuery || undefined,
      ),
    staleTime: 10_000,
    enabled: chatApiReady,
  });
  const recentSessions = recentQuery.data?.sessions ?? [];
  const agentOptions = useMemo(
    () =>
      (agentsQuery.data ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
      })),
    [agentsQuery.data],
  );
  const modelOptions = modelsQuery.data?.models ?? EMPTY_MODELS;

  const historyQuery = useQuery({
    queryKey: chatHistoryQueryKey(auth.token, sessionId),
    queryFn: () => loadChatHistoryUi(auth.token, sessionId),
    enabled: chatApiReady && Boolean(sessionId),
    staleTime: Infinity,
  });

  const contextQuery = useQuery({
    queryKey: ['chat-context', auth.token, sessionId],
    queryFn: () => fetchChatContext(auth.token, sessionId),
    enabled: chatApiReady && Boolean(sessionId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const messages = historyQuery.data?.messages ?? EMPTY_MESSAGES;
  const branchFamilies =
    historyQuery.data?.branchFamilies ?? EMPTY_BRANCH_FAMILIES;

  // Forward fetch errors inline rather than throwing to the page-level error
  // boundary — a failed background refetch (invalidated after each stream)
  // would otherwise tear down ChatPage and lose composer/session state.
  useEffect(() => {
    const id = contextQuery.data?.snapshot?.model?.trim() ?? '';
    if (id) setSelectedModelId(id);
  }, [contextQuery.data?.snapshot?.model]);

  useEffect(() => {
    if (!historyQuery.error) return;
    setError(getErrorMessage(historyQuery.error));
  }, [historyQuery.error]);

  useEffect(() => {
    if (!mobileQr) return;
    const previousOverflow = document.body.style.overflow;
    const previousActiveElement = document.activeElement;
    document.body.style.overflow = 'hidden';
    mobileQrCloseRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileQr(null);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        mobileQrDialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled)',
        ) ?? [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousActiveElement instanceof HTMLElement) {
        previousActiveElement.focus();
      }
    };
  }, [mobileQr]);

  // Server may resolve to a canonical branch id; keep the URL in sync.
  useEffect(() => {
    const resolved = historyQuery.data?.resolvedSessionId;
    if (!resolved || resolved === sessionId) return;
    void navigateToSession(resolved, { replace: true });
  }, [historyQuery.data?.resolvedSessionId, sessionId, navigateToSession]);

  const branchInfoMap = useMemo(
    () => buildBranchInfoMap(messages, branchFamilies),
    [messages, branchFamilies],
  );

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !stream.isStreaming && sessionId) {
      void queryClient.invalidateQueries({
        queryKey: ['chat-context', auth.token, sessionId],
      });
    }
    wasStreamingRef.current = stream.isStreaming;
  }, [stream.isStreaming, queryClient, auth.token, sessionId]);

  const scrollRafRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally re-runs on message changes to auto-scroll
  useEffect(() => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      if (isScrolledNearBottom(messageAreaRef.current)) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    });
  }, [messages]);
  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const handleEditSave = useCallback(
    async (msg: ChatMessage, newContent: string) => {
      if (!msg.messageId || !msg.sessionId) {
        setError('This message cannot be edited right now.');
        return;
      }
      setEditingId(null);
      try {
        const branch = await createChatBranch(
          auth.token,
          msg.sessionId,
          msg.messageId,
        );
        void queryClient.invalidateQueries({
          queryKey: chatHistoryQueryKey(auth.token, msg.sessionId),
          refetchType: 'none',
        });
        // Prefetch the branch's history so the message list doesn't flash empty
        // before the deferred sendMessage fires.
        await queryClient.ensureQueryData({
          queryKey: chatHistoryQueryKey(auth.token, branch.sessionId),
          queryFn: () => loadChatHistoryUi(auth.token, branch.sessionId),
        });
        // Bind the ref before sending so the stream captures the branch's
        // sessionId even if React hasn't committed the URL-driven re-render yet.
        await switchToSession(branch.sessionId);
        void stream.sendMessage(newContent, msg.media ?? []);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [auth.token, queryClient, switchToSession, stream.sendMessage],
  );

  const handleRegenerate = useCallback(
    (msg: ChatMessage) => {
      if (!msg.replayRequest) return;
      void stream.sendMessage(
        msg.replayRequest.content,
        msg.replayRequest.media,
        { hideUser: true },
      );
    },
    [stream.sendMessage],
  );

  const handleApprovalAction = useCallback(
    async (action: ApprovalAction, approvalId: string) => {
      const cmd = buildApprovalCommand(action, approvalId);
      if (!cmd) return;
      setApprovalBusy(true);
      try {
        await stream.sendMessage(cmd, [], { hideUser: true });
      } finally {
        setApprovalBusy(false);
      }
    },
    [stream.sendMessage],
  );

  const handleUploadFiles = useCallback(
    async (files: File[]): Promise<MediaItem[]> => {
      const results = await Promise.allSettled(
        files.map((file) => uploadMedia(auth.token, file)),
      );
      const uploaded: MediaItem[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.media) {
          uploaded.push(r.value.media);
        } else if (r.status === 'rejected') {
          setError(getErrorMessage(r.reason));
        }
      }
      return uploaded;
    },
    [auth.token],
  );

  const handleNewChat = useCallback(() => {
    if (stream.isActive()) {
      setError('Stop the current run before starting a new chat.');
      return;
    }
    startFreshChat();
    refreshRecent();
  }, [stream.isActive, startFreshChat, refreshRecent]);

  const handleSendMessage = useCallback(
    (content: string, media: MediaItem[]) => {
      ensureSessionForSend();
      void stream.sendMessage(content, media);
    },
    [ensureSessionForSend, stream.sendMessage],
  );

  const appendLocalCommandResult = useCallback(
    (targetSessionId: string, content: string) => {
      const text = content.trim();
      if (!text) return;
      queryClient.setQueryData<ChatHistoryUiData>(
        chatHistoryQueryKey(auth.token, targetSessionId),
        (prev) => ({
          messages: [
            ...(prev?.messages ?? []),
            {
              id: nextMsgId(),
              role: 'assistant',
              content: text,
              rawContent: text,
              sessionId: targetSessionId,
              artifacts: [],
              replayRequest: null,
            },
          ],
          branchFamilies: prev?.branchFamilies ?? new Map(),
          resolvedSessionId: targetSessionId,
        }),
      );
    },
    [auth.token, queryClient],
  );

  const sendSlashSwitch = useCallback(
    async (
      commandArgs: string[],
      value: string,
      onAccepted: (value: string) => void,
      busyMessage: string,
    ) => {
      if (!value || /\s/.test(value)) return;
      if (stream.isActive()) {
        setError(busyMessage);
        return;
      }
      ensureSessionForSend();
      const requestedSessionId = getSessionId();
      try {
        const result = await executeCommand(
          auth.token,
          requestedSessionId,
          userId,
          [...commandArgs, value],
        );
        const resolvedSessionId =
          result.sessionId?.trim() || requestedSessionId;
        await queryClient
          .ensureQueryData({
            queryKey: chatHistoryQueryKey(auth.token, resolvedSessionId),
            queryFn: () => loadChatHistoryUi(auth.token, resolvedSessionId),
          })
          .catch(() => null);
        appendLocalCommandResult(resolvedSessionId, result.text);
        if (resolvedSessionId !== requestedSessionId) {
          await switchToSession(resolvedSessionId, { replace: true });
        }
        void queryClient.invalidateQueries({
          queryKey: ['chat-context', auth.token, resolvedSessionId],
        });
        refreshRecent();
        onAccepted(value);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [
      appendLocalCommandResult,
      auth.token,
      ensureSessionForSend,
      getSessionId,
      queryClient,
      refreshRecent,
      stream.isActive,
      switchToSession,
      userId,
    ],
  );

  const handleAgentSwitch = useCallback(
    (agentId: string) =>
      sendSlashSwitch(
        ['agent', 'switch'],
        agentId,
        setSelectedAgentId,
        'Could not switch agent — stop the current run and try again.',
      ),
    [sendSlashSwitch],
  );

  const handleModelSwitch = useCallback(
    (modelId: string) =>
      sendSlashSwitch(
        ['model', 'set'],
        modelId,
        setSelectedModelId,
        'Could not switch model — stop the current run and try again.',
      ),
    [sendSlashSwitch],
  );

  const handleOpenSession = useCallback(
    (targetId: string) => {
      if (stream.isActive()) {
        setError('Stop the current run before switching chats.');
        return;
      }
      void navigateToSession(targetId);
    },
    [stream.isActive, navigateToSession],
  );

  const handleHoverSession = useCallback(
    (targetId: string) => {
      if (targetId === getSessionId()) return;
      void queryClient.prefetchQuery({
        queryKey: chatHistoryQueryKey(auth.token, targetId),
        queryFn: () => loadChatHistoryUi(auth.token, targetId),
        staleTime: 30_000,
      });
    },
    [queryClient, auth.token, getSessionId],
  );

  const handleRefreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['chat-recent', auth.token, userId, trimmedSessionSearchQuery],
    });
  }, [queryClient, auth.token, userId, trimmedSessionSearchQuery]);

  const handleOpenMobileQr = useCallback(async () => {
    const activeSessionId = getSessionId();
    if (!activeSessionId) {
      setError('Open or send a chat before creating a mobile QR code.');
      return;
    }
    setMobileQrBusy(true);
    try {
      setMobileQr(
        await createChatMobileQr(auth.token, {
          userId,
          sessionId: activeSessionId,
          baseUrl: window.location.origin,
        }),
      );
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setMobileQrBusy(false);
    }
  }, [auth.token, getSessionId, userId]);

  const handleEditOpen = useCallback((m: ChatMessage) => {
    setEditingId(m.id);
  }, []);

  const handleBranchNav = useCallback(
    (msg: ChatMessage, direction: -1 | 1) => {
      const key = msg.branchKey;
      if (!key) return;
      const variants = branchFamilies.get(key);
      if (!variants || variants.length < 2) return;
      const currentIdx = variants.findIndex(
        (variant) => variant.sessionId === msg.sessionId,
      );
      if (currentIdx < 0) return;
      const nextIdx = currentIdx + direction;
      if (nextIdx < 0 || nextIdx >= variants.length) return;
      const nextVariant = variants[nextIdx];
      if (!nextVariant) return;
      handleOpenSession(nextVariant.sessionId);
    },
    [branchFamilies, handleOpenSession],
  );

  const isEmpty = messages.length === 0;
  const isSwitchingSession = historyQuery.isFetching;

  const sidebarProps = {
    sessions: recentSessions,
    activeSessionId: sessionId,
    onNewChat: handleNewChat,
    onOpenSession: handleOpenSession,
    onHoverSession: handleHoverSession,
    isPending: isSwitchingSession,
    searchQuery: sessionSearchQuery,
    onSearchQueryChange: setSessionSearchQuery,
    isLoading: recentQuery.isFetching,
    onRefreshRecent: handleRefreshRecent,
  } as const;

  return (
    <ChatSidebarProvider>
      <div className={css.chatPage} aria-busy={isSwitchingSession}>
        <ChatSidebarPanel {...sidebarProps} />

        <div className={css.chatMain}>
          <div className={css.chatTopbar}>
            <MobileTopbarTrigger className={css.chatMobileTrigger} />
            <ContextRing sessionId={sessionId} />
            <button
              type="button"
              className={css.mobileQrButton}
              onClick={() => void handleOpenMobileQr()}
              disabled={mobileQrBusy}
              aria-label="Show mobile QR code"
              title="Show mobile QR code"
            >
              <span aria-hidden="true" className={css.mobileQrIcon}>
                <span />
                <span />
                <span />
                <span />
              </span>
            </button>
            <ViewSwitchNav />
          </div>
          {mobileQr ? (
            <div className={css.mobileQrOverlay}>
              <div
                ref={mobileQrDialogRef}
                className={css.mobileQrDialog}
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-qr-title"
              >
                <div className={css.mobileQrHeader}>
                  <h2 id="mobile-qr-title">Open on mobile</h2>
                  <button
                    ref={mobileQrCloseRef}
                    type="button"
                    className={css.mobileQrClose}
                    onClick={() => setMobileQr(null)}
                    aria-label="Close mobile QR code"
                  >
                    x
                  </button>
                </div>
                <div className={css.mobileQrImage}>
                  <img
                    src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(mobileQr.qrSvg)}`}
                    alt="Mobile session QR code"
                  />
                </div>
                <a className={css.mobileQrLink} href={mobileQr.launchUrl}>
                  Open link
                </a>
              </div>
            </div>
          ) : null}
          {isEmpty ? (
            <div className={css.emptyState}>
              <h1 className={css.greeting}>
                Ready to claw through your to-do list?
              </h1>
            </div>
          ) : (
            <div className={css.messageArea} ref={messageAreaRef}>
              <div className={css.messageList}>
                {messages.map((msg) =>
                  editingId === msg.id && msg.role !== 'thinking' ? (
                    <div key={msg.id} className={css.messageBlock}>
                      <EditInline
                        initial={msg.rawContent ?? msg.content}
                        onSave={(newContent) =>
                          void handleEditSave(msg, newContent)
                        }
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                  ) : (
                    <MessageBlock
                      key={msg.id}
                      message={msg}
                      token={auth.token}
                      isStreaming={msg.id === stream.streamingMsgId}
                      onCopy={copyToClipboard}
                      onEdit={handleEditOpen}
                      onRegenerate={handleRegenerate}
                      onApprovalAction={handleApprovalAction}
                      approvalBusy={approvalBusy}
                      branchInfo={branchInfoMap.get(msg.id) ?? null}
                      onBranchNav={handleBranchNav}
                    />
                  ),
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}

          {error ? <div className={css.errorBanner}>{error}</div> : null}

          <Composer
            isStreaming={stream.isStreaming}
            onSend={handleSendMessage}
            onStop={() => void stream.stopRequest()}
            onUploadFiles={handleUploadFiles}
            token={auth.token}
            agents={agentOptions}
            selectedAgentId={selectedAgentId}
            onAgentSwitch={(agentId) => void handleAgentSwitch(agentId)}
            models={modelOptions}
            selectedModelId={selectedModelId}
            onModelSwitch={(modelId) => void handleModelSwitch(modelId)}
          />
        </div>
      </div>
    </ChatSidebarProvider>
  );
}
