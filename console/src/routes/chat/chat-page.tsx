import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from 'react';
import {
  createChatBranch,
  fetchAppStatus,
  fetchChatHistory,
  fetchChatRecent,
  uploadMedia,
} from '../../api/chat';
import type {
  BranchVariant,
  ChatMessage,
  MediaItem,
} from '../../api/chat-types';
import { useAuth } from '../../auth';
import { ViewSwitchNav } from '../../components/view-switch';
import {
  type ApprovalAction,
  buildApprovalCommand,
  copyToClipboard,
  DEFAULT_AGENT_ID,
  generateWebSessionId,
  isScrolledNearBottom,
  nextMsgId,
  readStoredSessionId,
  readStoredUserId,
  storeSessionId,
} from '../../lib/chat-helpers';
import { CHAT_UI_CONFIG } from '../../lib/chat-ui-config';
import { getErrorMessage } from '../../lib/error-message';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import css from './chat-page.module.css';
import { ChatSidebarPanel, ChatSidebarProvider } from './chat-sidebar';
import type { ChatUiMessage } from './chat-ui-message';
import { Composer } from './composer';
import { EditInline, MessageBlock } from './message-block';
import { useChatStream } from './use-chat-stream';

type BranchInfo = {
  current: number;
  total: number;
};

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

/* ── State reducer ───────────────────────────────────────── */

interface ChatState {
  sessionId: string;
  messages: ChatUiMessage[];
  error: string;
  editingId: string | null;
  approvalBusy: boolean;
  branchFamilies: Map<string, BranchVariant[]>;
}

type ChatAction =
  | { type: 'SESSION_SWITCH'; sessionId: string }
  | { type: 'SESSION_ID_UPDATE'; sessionId: string }
  | {
      type: 'HISTORY_LOADED';
      messages: ChatMessage[];
      branchFamilies: Map<string, BranchVariant[]>;
      sessionId?: string;
    }
  | {
      type: 'MESSAGES_SET';
      updater: ChatUiMessage[] | ((prev: ChatUiMessage[]) => ChatUiMessage[]);
    }
  | { type: 'ERROR_SET'; error: string }
  | { type: 'ERROR_CLEAR' }
  | { type: 'EDIT_START'; id: string }
  | { type: 'EDIT_CANCEL' }
  | { type: 'APPROVAL_BUSY_SET'; busy: boolean };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'SESSION_ID_UPDATE':
      return { ...state, sessionId: action.sessionId };
    case 'SESSION_SWITCH':
      return {
        ...state,
        sessionId: action.sessionId,
        messages: [],
        error: '',
        editingId: null,
        approvalBusy: false,
        branchFamilies: new Map(),
      };
    case 'HISTORY_LOADED':
      return {
        ...state,
        messages: action.messages,
        branchFamilies: action.branchFamilies,
        error: '',
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
      };
    case 'MESSAGES_SET': {
      const messages =
        typeof action.updater === 'function'
          ? action.updater(state.messages)
          : action.updater;
      return { ...state, messages };
    }
    case 'ERROR_SET':
      return { ...state, error: action.error };
    case 'ERROR_CLEAR':
      return { ...state, error: '' };
    case 'EDIT_START':
      return { ...state, editingId: action.id };
    case 'EDIT_CANCEL':
      return { ...state, editingId: null };
    case 'APPROVAL_BUSY_SET':
      return { ...state, approvalBusy: action.busy };
    default:
      return state;
  }
}

/* ── ChatPage ────────────────────────────────────────────── */

export function ChatPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const userId = useRef(readStoredUserId()).current;
  const defaultAgentIdRef = useRef(DEFAULT_AGENT_ID);

  const [state, dispatch] = useReducer(
    chatReducer,
    undefined,
    (): ChatState => {
      const stored = readStoredSessionId();
      const sessionId =
        stored ||
        (() => {
          const id = generateWebSessionId();
          storeSessionId(id);
          return id;
        })();
      return {
        sessionId,
        messages: [],
        error: '',
        editingId: null,
        approvalBusy: false,
        branchFamilies: new Map(),
      };
    },
  );
  const {
    sessionId,
    messages,
    error,
    editingId,
    approvalBusy,
    branchFamilies,
  } = state;

  const [isPending, startTransition] = useTransition();
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const debouncedSessionSearchQuery = useDebouncedValue(
    sessionSearchQuery,
    160,
  );
  const trimmedSessionSearchQuery = debouncedSessionSearchQuery.trim();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageAreaRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const pendingEditRef = useRef<{
    content: string;
    media: MediaItem[];
  } | null>(null);

  const refreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['chat-recent', auth.token, userId],
    });
    // Also invalidate the current session's history cache so that
    // switching away and back refetches with the streamed messages.
    void queryClient.invalidateQueries({
      queryKey: ['chat-history', auth.token, sessionIdRef.current],
    });
  }, [queryClient, auth.token, userId]);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  const setMessages = useCallback(
    (
      updater: ChatUiMessage[] | ((prev: ChatUiMessage[]) => ChatUiMessage[]),
    ) => {
      dispatch({ type: 'MESSAGES_SET', updater });
    },
    [],
  );

  const setSessionId = useCallback((id: string) => {
    dispatch({ type: 'SESSION_ID_UPDATE', sessionId: id });
  }, []);

  const setError = useCallback((err: string) => {
    if (err === '') dispatch({ type: 'ERROR_CLEAR' });
    else dispatch({ type: 'ERROR_SET', error: err });
  }, []);

  const stream = useChatStream({
    token: auth.token,
    userId,
    getSessionId,
    setMessages,
    setSessionId,
    setError,
    refreshRecent,
  });

  // Stable ref for history-load effect to call sendMessage without stale closure
  const sendMessageRef = useRef(stream.sendMessage);
  sendMessageRef.current = stream.sendMessage;

  useEffect(() => {
    storeSessionId(sessionId);
  }, [sessionId]);

  const appStatusQuery = useQuery({
    queryKey: ['app-status', auth.token],
    queryFn: () => fetchAppStatus(auth.token),
    staleTime: Infinity,
  });

  useEffect(() => {
    const id = appStatusQuery.data?.defaultAgentId;
    if (id) {
      defaultAgentIdRef.current = id.trim().toLowerCase();
    }
  }, [appStatusQuery.data?.defaultAgentId]);

  useEffect(() => {
    if (!appStatusQuery.error) return;
    console.error(
      'Failed to load gateway status for chat page',
      appStatusQuery.error,
    );
    dispatch({
      type: 'ERROR_SET',
      error:
        'Failed to load the default agent. New chats will use main until gateway status loads.',
    });
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

  const historyQuery = useQuery({
    queryKey: ['chat-history', auth.token, sessionId],
    queryFn: () => fetchChatHistory(auth.token, sessionId),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
  });

  // Forward fetch errors inline rather than throwing to the page-level error
  // boundary — a failed background refetch (invalidated after each stream)
  // would otherwise tear down ChatPage and lose composer/session state.
  useEffect(() => {
    if (!historyQuery.error) return;
    dispatch({
      type: 'ERROR_SET',
      error: getErrorMessage(historyQuery.error),
    });
  }, [historyQuery.error]);

  useEffect(() => {
    const data = historyQuery.data;
    if (!data) return;

    const resolvedSessionId = data.sessionId ?? sessionId;
    const loadedBranchFamilies = new Map(
      (data.branchFamilies ?? []).map((bf) => [
        `${bf.anchorSessionId}:${bf.anchorMessageId}`,
        bf.variants,
      ]),
    );
    const branchKeysByMessageId = new Map<number | string, string>();
    for (const [branchKey, variants] of loadedBranchFamilies.entries()) {
      const currentVariant = variants.find(
        (variant) => variant.sessionId === resolvedSessionId,
      );
      if (!currentVariant) continue;
      branchKeysByMessageId.set(currentVariant.messageId, branchKey);
    }

    const loaded: ChatMessage[] = (data.history ?? []).map((msg) => ({
      id: nextMsgId(),
      role: msg.role,
      content: msg.content,
      rawContent: msg.content,
      sessionId: resolvedSessionId,
      messageId: msg.id ?? null,
      media: [],
      artifacts: [],
      replayRequest:
        msg.role === 'user' ? { content: msg.content, media: [] } : null,
      assistantPresentation: data.assistantPresentation ?? null,
      branchKey:
        msg.id !== undefined && msg.id !== null
          ? (branchKeysByMessageId.get(msg.id) ?? null)
          : null,
    }));

    dispatch({
      type: 'HISTORY_LOADED',
      messages: loaded,
      branchFamilies: loadedBranchFamilies,
      sessionId: data.sessionId !== sessionId ? data.sessionId : undefined,
    });

    // Flush pending edit
    const pending = pendingEditRef.current;
    if (pending) {
      pendingEditRef.current = null;
      void sendMessageRef.current(pending.content, pending.media);
    }
  }, [historyQuery.data, sessionId]);

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

  /* ── Handlers ───────────────────────────────────────────── */

  const handleEditSave = useCallback(
    async (msg: ChatMessage, newContent: string) => {
      if (!msg.messageId || !msg.sessionId) {
        dispatch({
          type: 'ERROR_SET',
          error: 'This message cannot be edited right now.',
        });
        return;
      }
      dispatch({ type: 'EDIT_CANCEL' });
      try {
        const branch = await createChatBranch(
          auth.token,
          msg.sessionId,
          msg.messageId,
        );
        pendingEditRef.current = {
          content: newContent,
          media: msg.media ?? [],
        };
        startTransition(() => {
          dispatch({ type: 'SESSION_SWITCH', sessionId: branch.sessionId });
        });
      } catch (err) {
        dispatch({
          type: 'ERROR_SET',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [auth.token],
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
      dispatch({ type: 'APPROVAL_BUSY_SET', busy: true });
      try {
        await stream.sendMessage(cmd, [], { hideUser: true });
      } finally {
        dispatch({ type: 'APPROVAL_BUSY_SET', busy: false });
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
          const err = r.reason;
          dispatch({
            type: 'ERROR_SET',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return uploaded;
    },
    [auth.token],
  );

  const handleNewChat = useCallback(() => {
    if (stream.isActive()) {
      dispatch({
        type: 'ERROR_SET',
        error: 'Stop the current run before starting a new chat.',
      });
      return;
    }
    dispatch({
      type: 'SESSION_SWITCH',
      sessionId: generateWebSessionId(defaultAgentIdRef.current),
    });
    refreshRecent();
  }, [stream, refreshRecent]);

  const handleOpenSession = useCallback(
    (targetId: string) => {
      if (stream.isActive()) {
        dispatch({
          type: 'ERROR_SET',
          error: 'Stop the current run before switching chats.',
        });
        return;
      }
      startTransition(() => {
        dispatch({ type: 'SESSION_SWITCH', sessionId: targetId });
      });
    },
    [stream],
  );

  const handleHoverSession = useCallback(
    (targetId: string) => {
      void queryClient.prefetchQuery({
        queryKey: ['chat-history', auth.token, targetId],
        queryFn: () => fetchChatHistory(auth.token, targetId),
        staleTime: 30_000,
      });
    },
    [queryClient, auth.token],
  );

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

  const sidebarProps = {
    sessions: recentSessions,
    activeSessionId: sessionId,
    onNewChat: handleNewChat,
    onOpenSession: handleOpenSession,
    onHoverSession: handleHoverSession,
    isPending,
    searchQuery: sessionSearchQuery,
    onSearchQueryChange: setSessionSearchQuery,
    isLoading: recentQuery.isFetching,
  } as const;

  return (
    <ChatSidebarProvider>
      <div className={css.chatPage} aria-busy={isPending}>
        <ChatSidebarPanel {...sidebarProps} />

        <div className={css.chatMain}>
          <div className={css.chatTopbar}>
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
                        onCancel={() => dispatch({ type: 'EDIT_CANCEL' })}
                      />
                    </div>
                  ) : (
                    <MessageBlock
                      key={msg.id}
                      message={msg}
                      token={auth.token}
                      isStreaming={msg.id === stream.streamingMsgId}
                      onCopy={copyToClipboard}
                      onEdit={(m) => dispatch({ type: 'EDIT_START', id: m.id })}
                      onRegenerate={handleRegenerate}
                      onApprovalAction={handleApprovalAction}
                      approvalBusy={approvalBusy}
                      branchInfo={branchInfoMap.get(msg.id) ?? null}
                      onBranchNav={(dir) => {
                        if (msg.role === 'thinking') return;
                        handleBranchNav(msg, dir);
                      }}
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
            onSend={(content, media) => void stream.sendMessage(content, media)}
            onStop={() => void stream.stopRequest()}
            onUploadFiles={handleUploadFiles}
            token={auth.token}
          />
        </div>
      </div>
    </ChatSidebarProvider>
  );
}
