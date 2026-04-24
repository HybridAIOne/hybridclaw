import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createChatBranch,
  fetchAppStatus,
  fetchChatRecent,
  uploadMedia,
} from '../../api/chat';
import type {
  BranchVariant,
  ChatMessage,
  MediaItem,
} from '../../api/chat-types';
import { fetchAgentsOverview } from '../../api/client';
import { useAuth } from '../../auth';
import { MobileTopbarTrigger } from '../../components/sidebar/index';
import { ViewSwitchNav } from '../../components/view-switch';
import {
  type ApprovalAction,
  buildApprovalCommand,
  copyToClipboard,
  DEFAULT_AGENT_ID,
  isScrolledNearBottom,
  readStoredUserId,
} from '../../lib/chat-helpers';
import { CHAT_UI_CONFIG } from '../../lib/chat-ui-config';
import { getErrorMessage } from '../../lib/error-message';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import {
  chatHistoryQueryKey,
  EMPTY_BRANCH_FAMILIES,
  loadChatHistoryUi,
} from './chat-history-query';
import css from './chat-page.module.css';
import { ChatSidebarPanel, ChatSidebarProvider } from './chat-sidebar';
import type { ChatUiMessage } from './chat-ui-message';
import { Composer } from './composer';
import { EditInline, MessageBlock } from './message-block';
import { useChatSession } from './use-chat-session';
import { useChatStream } from './use-chat-stream';

type BranchInfo = {
  current: number;
  total: number;
};

const EMPTY_MESSAGES: ChatUiMessage[] = [];

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
  const [selectedAgentId, setSelectedAgentId] = useState(
    defaultAgentIdRef.current,
  );

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const debouncedSessionSearchQuery = useDebouncedValue(
    sessionSearchQuery,
    160,
  );
  const trimmedSessionSearchQuery = debouncedSessionSearchQuery.trim();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);

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
  });

  const appStatusQuery = useQuery({
    queryKey: ['app-status', auth.token],
    queryFn: () => fetchAppStatus(auth.token),
    staleTime: Infinity,
  });

  const agentsQuery = useQuery({
    queryKey: ['agents-overview', auth.token],
    queryFn: () => fetchAgentsOverview(auth.token),
    staleTime: 30_000,
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
  });
  const recentSessions = recentQuery.data?.sessions ?? [];
  const agentOptions = useMemo(
    () =>
      (agentsQuery.data?.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
      })),
    [agentsQuery.data?.agents],
  );

  useEffect(() => {
    if (!sessionId) return;
    const currentSession = agentsQuery.data?.sessions.find(
      (entry) => entry.sessionId === sessionId,
    );
    if (currentSession?.agentId) {
      setSelectedAgentId(currentSession.agentId);
    }
  }, [agentsQuery.data?.sessions, sessionId]);

  const historyQuery = useQuery({
    queryKey: chatHistoryQueryKey(auth.token, sessionId),
    queryFn: () => loadChatHistoryUi(auth.token, sessionId),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });

  const messages = historyQuery.data?.messages ?? EMPTY_MESSAGES;
  const branchFamilies =
    historyQuery.data?.branchFamilies ?? EMPTY_BRANCH_FAMILIES;

  // Forward fetch errors inline rather than throwing to the page-level error
  // boundary — a failed background refetch (invalidated after each stream)
  // would otherwise tear down ChatPage and lose composer/session state.
  useEffect(() => {
    if (!historyQuery.error) return;
    setError(getErrorMessage(historyQuery.error));
  }, [historyQuery.error]);

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

  const handleAgentSwitch = useCallback(
    async (agentId: string) => {
      ensureSessionForSend();
      const accepted = await stream.sendMessage(
        `/agent switch ${agentId}`,
        [],
        {
          hideUser: true,
        },
      );
      if (accepted) {
        setSelectedAgentId(agentId);
        void queryClient.invalidateQueries({
          queryKey: ['agents-overview', auth.token],
        });
      }
    },
    [ensureSessionForSend, stream.sendMessage, queryClient, auth.token],
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
  } as const;

  return (
    <ChatSidebarProvider>
      <div className={css.chatPage} aria-busy={isSwitchingSession}>
        <ChatSidebarPanel {...sidebarProps} />

        <div className={css.chatMain}>
          <div className={css.chatTopbar}>
            <MobileTopbarTrigger className={css.chatMobileTrigger} />
            <ViewSwitchNav />
          </div>
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
          />
        </div>
      </div>
    </ChatSidebarProvider>
  );
}
