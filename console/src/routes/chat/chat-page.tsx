import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createChatBranch,
  fetchChatHistory,
  fetchChatRecent,
  uploadMedia,
} from '../../api/chat';
import type {
  BranchVariant,
  ChatMessage,
  MediaItem,
} from '../../api/chat-types';
import { validateToken } from '../../api/client';
import { useAuth } from '../../auth';
import { useSidebar } from '../../components/sidebar/index';
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
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';
import { ChatSidebar } from './chat-sidebar';
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

  const sidebar = useSidebar();

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run only on mount/unmount — sidebar state changes must not re-trigger
  useEffect(() => {
    const wasOpen = sidebar.open;
    if (wasOpen && !sidebar.isMobile) {
      sidebar.setOpen(false);
    }
    return () => {
      if (wasOpen && !sidebar.isMobile) {
        sidebar.setOpen(true);
      }
    };
  }, []);

  const [sessionId, setSessionId] = useState<string>(() => {
    const stored = readStoredSessionId();
    return stored || generateWebSessionId();
  });
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [error, setError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [branchFamilies, setBranchFamilies] = useState<
    Map<string, BranchVariant[]>
  >(new Map());
  const [branchInfoMap, setBranchInfoMap] = useState<Map<string, BranchInfo>>(
    new Map(),
  );

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
  }, [queryClient, auth.token, userId]);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

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

  useEffect(() => {
    void validateToken(auth.token)
      .then((status) => {
        if (status.defaultAgentId) {
          defaultAgentIdRef.current = status.defaultAgentId
            .trim()
            .toLowerCase();
        }
      })
      .catch((err) => {
        console.error('Failed to load gateway status for chat page', err);
        setError(
          (prev) =>
            prev ||
            'Failed to load the default agent. New chats will use main until gateway status loads.',
        );
      });
  }, [auth.token]);

  const recentQuery = useQuery({
    queryKey: ['chat-recent', auth.token, userId],
    queryFn: () => fetchChatRecent(auth.token, userId),
    staleTime: 10_000,
  });
  const recentSessions = recentQuery.data?.sessions ?? [];

  const historyQuery = useQuery({
    queryKey: ['chat-history', auth.token, sessionId],
    queryFn: () => fetchChatHistory(auth.token, sessionId),
    enabled: Boolean(sessionId),
    staleTime: 45_000,
    refetchOnWindowFocus: false,
  });

  // Apply loaded history when session changes; flush queued edit if pending
  useEffect(() => {
    const data = historyQuery.data;
    if (!sessionId || !data) return;

    // Only update sessionId if the server returned a different one
    if (data.sessionId && data.sessionId !== sessionId) {
      setSessionId(data.sessionId);
    }

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
    setMessages(loaded);
    setBranchFamilies(loadedBranchFamilies);
    setBranchInfoMap(buildBranchInfoMap(loaded, loadedBranchFamilies));
    setError('');

    const pending = pendingEditRef.current;
    if (pending) {
      pendingEditRef.current = null;
      void sendMessageRef.current(pending.content, pending.media);
    }
  }, [historyQuery.data, sessionId]);

  useEffect(() => {
    if (!historyQuery.error) return;
    setError(
      historyQuery.error instanceof Error
        ? historyQuery.error.message
        : String(historyQuery.error),
    );
  }, [historyQuery.error]);

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

  const resetChatState = useCallback(() => {
    setMessages([]);
    setBranchFamilies(new Map());
    setBranchInfoMap(new Map());
    setError('');
    setEditingId(null);
    setMobileSidebarOpen(false);
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
        pendingEditRef.current = {
          content: newContent,
          media: msg.media ?? [],
        };
        setSessionId(branch.sessionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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
          const err = r.reason;
          setError(err instanceof Error ? err.message : String(err));
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
    resetChatState();
    setSessionId(generateWebSessionId(defaultAgentIdRef.current));
    refreshRecent();
  }, [stream, resetChatState, refreshRecent]);

  const handleOpenSession = useCallback(
    (targetId: string) => {
      if (stream.isActive()) {
        setError('Stop the current run before switching chats.');
        return;
      }
      resetChatState();
      setSessionId(targetId);
    },
    [stream, resetChatState],
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

  /* ── Render ─────────────────────────────────────────────── */

  const isEmpty = messages.length === 0;

  const sidebarProps = {
    sessions: recentSessions,
    activeSessionId: sessionId,
    onNewChat: handleNewChat,
    onOpenSession: handleOpenSession,
  } as const;

  return (
    <div className={css.chatPage}>
      {mobileSidebarOpen ? (
        <button
          type="button"
          className={css.sidebarBackdrop}
          tabIndex={-1}
          aria-label="Close sidebar"
          onClick={() => setMobileSidebarOpen(false)}
        />
      ) : null}

      <div className={cx(css.sidebar, mobileSidebarOpen && css.sidebarOpen)}>
        <ChatSidebar {...sidebarProps} />
      </div>

      <div className={css.chatMain}>
        <div className={css.mobileHeader}>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Open chat sidebar"
          >
            ☰
          </button>
          <span style={{ fontWeight: 600 }}>HybridClaw</span>
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
                    onEdit={(m) => setEditingId(m.id)}
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
  );
}
