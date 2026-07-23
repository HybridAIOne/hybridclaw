import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { appViewUrl } from '../../api/apps';
import {
  cleanupNoUserChatSessions,
  createChatBranch,
  createChatMobileQr,
  executeCommand,
  fetchAppStatus,
  fetchChatContext,
  fetchChatRecent,
  rateChatResponse,
  uploadMedia,
} from '../../api/chat';
import type {
  BranchVariant,
  ChatMessage,
  ChatMobileQrResponse,
  ChatRecentSession,
  MediaItem,
  ResponseRatingValue,
} from '../../api/chat-types';
import {
  deleteSession as deleteChatSession,
  fetchAgentList,
  fetchModels,
  fetchSkills,
} from '../../api/client';
import type { ChatModel } from '../../api/types';
import { isAuthReadyForApi, useAuth } from '../../auth';
import { Button } from '../../components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/dialog';
import { LiveAppFrame } from '../../components/live-app-frame';
import { MobileTopbarTrigger } from '../../components/sidebar/index';
import {
  useConfiguredViewSwitchItems,
  ViewSwitchNav,
} from '../../components/view-switch';
import { buildAppSeed } from '../../lib/app-seed';
import { createAppViewToken } from '../../lib/app-view-token';
import {
  type ApprovalAction,
  buildApprovalCommand,
  copyToClipboard,
  DEFAULT_AGENT_ID,
  nextMsgId,
  readStoredUserId,
} from '../../lib/chat-helpers';
import { CHAT_UI_CONFIG } from '../../lib/chat-ui-config';
import { getErrorMessage } from '../../lib/error-message';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { findAgentMentions } from './agent-mention-display';
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
import { useStickToBottom } from './use-stick-to-bottom';

type BranchInfo = {
  current: number;
  total: number;
};

const EMPTY_MESSAGES: ChatUiMessage[] = [];
const EMPTY_MODELS: ChatModel[] = [];
const ERROR_BANNER_VISIBLE_MS = 5000;
const ERROR_BANNER_FADE_MS = 200;
const BOOTSTRAP_AUTOSTART_THINKING_ID = 'bootstrap-autostart-thinking';
const BOOTSTRAP_AUTOSTART_REFETCH_MS = 1500;
const DEFAULT_EMPTY_CHAT_HEADER = 'Ready to claw through your to-do list?';
type RecentChatScope = 'user' | 'all';

const AGENT_QUERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readLaunchAgentId(): string {
  const value = new URLSearchParams(window.location.search)
    .get('agent')
    ?.trim();
  if (!value) return '';
  return AGENT_QUERY_ID_PATTERN.test(value) ? value : '';
}

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

function chatRecentQueryKey(
  token: string,
  userId: string,
  query = '',
  scope: RecentChatScope = 'user',
) {
  return ['chat-recent', token, userId, query, scope] as const;
}

function chatRecentQueryPrefix(token: string, userId: string) {
  return ['chat-recent', token, userId] as const;
}

function chatContextQueryKey(token: string, sessionId: string) {
  return ['chat-context', token, sessionId] as const;
}

type AppBuildSessionInfo = { category?: string; kind?: 'web' | 'live' };
const APP_BUILD_SESSIONS_KEY = 'hybridclaw.appBuildSessions';

// App-build session tags are persisted so follow-up build turns (and the
// finished-build popup) keep working after a page reload.
function loadAppBuildSessions(): Map<string, AppBuildSessionInfo> {
  try {
    const raw = localStorage.getItem(APP_BUILD_SESSIONS_KEY);
    if (!raw) return new Map();
    return new Map(
      Object.entries(JSON.parse(raw) as Record<string, AppBuildSessionInfo>),
    );
  } catch {
    return new Map();
  }
}

function saveAppBuildSessions(map: Map<string, AppBuildSessionInfo>): void {
  try {
    localStorage.setItem(
      APP_BUILD_SESSIONS_KEY,
      JSON.stringify(Object.fromEntries(map)),
    );
  } catch {
    // ignore storage failures (private mode, quota)
  }
}

export function ChatPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userId = useRef(readStoredUserId()).current;
  // A `?prompt=` seed prefills the composer. When paired with `?send=1` (used
  // by the Apps builder and `/app`), it is auto-sent instead of prefilled.
  // Read from router state (not window.location) — the URL lags client-side
  // navigation, so window.location.search can be empty at first render.
  const chatSearch = useSearch({ strict: false }) as {
    prompt?: string;
    send?: string;
    app?: string;
    category?: string;
    kind?: string;
  };
  const [initialChatSeed] = useState(() => {
    const kind = chatSearch.kind;
    const appKind: 'web' | 'live' | undefined =
      kind === 'live' ? 'live' : kind === 'web' ? 'web' : undefined;
    return {
      prompt: chatSearch.prompt ?? '',
      autoSend: chatSearch.send === '1',
      appBuild: chatSearch.app === '1',
      appCategory: chatSearch.category,
      appKind,
    };
  });
  // Sessions started as app builds: each app-build turn is tagged so the
  // gateway captures the produced HTML into the Apps gallery. Persisted so a
  // reload mid-conversation doesn't drop the tag.
  const appBuildSessionsRef = useRef(loadAppBuildSessions());
  const markAppBuildSession = useCallback(
    (sessionId: string, info: AppBuildSessionInfo) => {
      appBuildSessionsRef.current.set(sessionId, info);
      saveAppBuildSessions(appBuildSessionsRef.current);
    },
    [],
  );
  const initialComposerPrompt = initialChatSeed.autoSend
    ? ''
    : initialChatSeed.prompt;
  const launchAgentId = useMemo(readLaunchAgentId, []);

  const [errorState, setErrorState] = useState({ message: '', version: 0 });
  const error = errorState.message;
  const setError = useCallback((next: SetStateAction<string>) => {
    setErrorState((prev) => ({
      message: typeof next === 'function' ? next(prev.message) : next,
      version: prev.version + 1,
    }));
  }, []);
  const [errorExiting, setErrorExiting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [mobileQr, setMobileQr] = useState<ChatMobileQrResponse | null>(null);
  const [mobileQrBusy, setMobileQrBusy] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    launchAgentId || null,
  );
  const [selectedModelId, setSelectedModelId] = useState('');
  const [recentChatScope, setRecentChatScope] =
    useState<RecentChatScope>('user');
  const [sessionPendingDelete, setSessionPendingDelete] =
    useState<ChatRecentSession | null>(null);

  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const launchAgentSessionIdRef = useRef<string | null>(null);
  const debouncedSessionSearchQuery = useDebouncedValue(
    sessionSearchQuery,
    160,
  );
  const trimmedSessionSearchQuery = debouncedSessionSearchQuery.trim();

  const {
    scrollRef: messageAreaRef,
    contentRef: messageListRef,
    isPinned,
    jumpToBottom,
    resetToBottom,
  } = useStickToBottom();
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

  const {
    sessionId,
    getSessionId,
    navigateToSession,
    switchToSession,
    startFreshChat,
    ensureSessionForSend,
    handleSessionIdCorrection,
  } = useChatSession();

  if (launchAgentId && sessionId && !launchAgentSessionIdRef.current) {
    launchAgentSessionIdRef.current = sessionId;
  }

  const requestedHistoryAgentId =
    sessionId && launchAgentSessionIdRef.current === sessionId
      ? launchAgentId
      : '';

  const refreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: chatRecentQueryPrefix(auth.token, userId),
    });
    void queryClient.invalidateQueries({
      queryKey: chatHistoryQueryKey(auth.token, getSessionId()),
      refetchType: 'none',
    });
  }, [queryClient, auth.token, userId, getSessionId]);

  const chatApiReady = isAuthReadyForApi(auth);
  const viewSwitchItems = useConfiguredViewSwitchItems(auth.token);

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
  const skillsQuery = useQuery({
    queryKey: ['skills', auth.token],
    queryFn: () => fetchSkills(auth.token),
    staleTime: 60_000,
    retry: false,
    enabled: chatApiReady,
  });

  // /model set is session-scoped on the gateway, so re-seed the local selection
  // to the gateway default whenever the session changes. We don't know what
  // model the new session was last set to, so the default is the best guess
  // until the user picks again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId intentionally resets the local model selection.
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
  }, [appStatusQuery.error, setError]);

  useEffect(() => {
    if (!modelsQuery.error) return;
    console.error(
      'Failed to load models list for chat page',
      modelsQuery.error,
    );
    setError('Failed to load the model list. Model switching is unavailable.');
  }, [modelsQuery.error, setError]);

  const recentQuery = useQuery({
    queryKey: chatRecentQueryKey(
      auth.token,
      userId,
      trimmedSessionSearchQuery,
      recentChatScope,
    ),
    queryFn: () =>
      fetchChatRecent(
        auth.token,
        userId,
        'web',
        trimmedSessionSearchQuery
          ? CHAT_UI_CONFIG.maxSearchResults
          : CHAT_UI_CONFIG.maxRecentSessions,
        trimmedSessionSearchQuery || undefined,
        recentChatScope,
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
        imageUrl: agent.imageUrl ?? null,
        emptyChatHeader: agent.emptyChatHeader ?? null,
        source: agent.source,
      })),
    [agentsQuery.data],
  );
  const skillInvocationTargets = useMemo(() => {
    return new Map(
      (skillsQuery.data?.skills ?? [])
        .filter((skill) => skill.userInvocable)
        .map((skill) => [skill.name.toLowerCase(), skill.name]),
    );
  }, [skillsQuery.data?.skills]);
  const resolveAddressedAgentPresentation = useCallback(
    (content: string) => {
      const mentions = findAgentMentions(content);
      for (const mention of mentions) {
        const agent = agentOptions.find(
          (option) => option.id.toLowerCase() === mention.agentId.toLowerCase(),
        );
        if (!agent) continue;
        return {
          agentId: agent.id,
          displayName: agent.name ?? agent.id,
          imageUrl: agent.imageUrl ?? null,
        };
      }
      return null;
    },
    [agentOptions],
  );
  const modelOptions = modelsQuery.data?.models ?? EMPTY_MODELS;

  const [previewApp, setPreviewApp] = useState<{
    id: string;
    title: string;
    kind: 'web' | 'live';
  } | null>(null);
  const [previewAppToken, setPreviewAppToken] = useState('');

  const stream = useChatStream({
    token: auth.token,
    userId,
    getSessionId,
    setError,
    refreshRecent,
    onSessionIdCorrection: handleSessionIdCorrection,
    onModelResolved: setSelectedModelId,
    // When a build is captured into the gallery, pop it open as a preview.
    onAppsCaptured: (apps) => setPreviewApp(apps[apps.length - 1] ?? null),
    resolveAddressedAgentPresentation,
  });

  useEffect(() => {
    let active = true;
    setPreviewAppToken('');
    if (!previewApp) return;

    createAppViewToken(auth.token, previewApp.id)
      .then((token) => {
        if (active) setPreviewAppToken(token);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setPreviewApp(null);
        setError(`Could not open app preview: ${getErrorMessage(error)}`);
      });

    return () => {
      active = false;
    };
  }, [auth.token, previewApp, setError]);

  useEffect(() => {
    const message = errorState.message;
    setErrorExiting(false);
    if (!message) return;
    const fadeTimer = window.setTimeout(() => {
      setErrorExiting(true);
    }, ERROR_BANNER_VISIBLE_MS);
    const clearTimer = window.setTimeout(() => {
      setError('');
      setErrorExiting(false);
    }, ERROR_BANNER_VISIBLE_MS + ERROR_BANNER_FADE_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
    };
  }, [errorState, setError]);

  const historyQuery = useQuery({
    queryKey: chatHistoryQueryKey(auth.token, sessionId),
    queryFn: () =>
      loadChatHistoryUi(
        auth.token,
        sessionId,
        userId,
        requestedHistoryAgentId || undefined,
      ),
    enabled: chatApiReady && Boolean(sessionId),
    staleTime: Infinity,
  });

  const contextQuery = useQuery({
    queryKey: chatContextQueryKey(auth.token, sessionId),
    queryFn: () => fetchChatContext(auth.token, sessionId),
    enabled: chatApiReady && Boolean(sessionId),
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const messages = historyQuery.data?.messages ?? EMPTY_MESSAGES;
  const isBootstrapAutostartStarting =
    historyQuery.data?.bootstrapAutostart?.status === 'starting';
  const visibleMessages = useMemo<ChatUiMessage[]>(() => {
    if (!isBootstrapAutostartStarting) return messages;
    return [
      ...messages,
      {
        id: BOOTSTRAP_AUTOSTART_THINKING_ID,
        role: 'thinking',
        content: '',
        sessionId,
      },
    ];
  }, [isBootstrapAutostartStarting, messages, sessionId]);
  const branchFamilies =
    historyQuery.data?.branchFamilies ?? EMPTY_BRANCH_FAMILIES;
  const effectiveAgentId =
    selectedAgentId?.trim().toLowerCase() ||
    historyQuery.data?.agentId?.trim().toLowerCase() ||
    appStatusQuery.data?.defaultAgentId?.trim().toLowerCase() ||
    DEFAULT_AGENT_ID;
  const emptyChatHeader =
    agentOptions
      .find((agent) => agent.id.toLowerCase() === effectiveAgentId)
      ?.emptyChatHeader?.trim() || DEFAULT_EMPTY_CHAT_HEADER;

  const deleteSessionMutation = useMutation({
    mutationFn: (targetSessionId: string) =>
      deleteChatSession(auth.token, targetSessionId),
    onSuccess: (data) => {
      if (!data.deleted) {
        setError('Delete failed: session was not found.');
        return;
      }
      const deletedSessionId = data.sessionId;
      queryClient.removeQueries({
        queryKey: chatHistoryQueryKey(auth.token, deletedSessionId),
      });
      queryClient.removeQueries({
        queryKey: chatContextQueryKey(auth.token, deletedSessionId),
      });
      void queryClient.invalidateQueries({
        queryKey: chatRecentQueryPrefix(auth.token, userId),
      });
      void queryClient.invalidateQueries({
        queryKey: ['overview'],
        refetchType: 'none',
      });
      setSessionPendingDelete(null);
      const currentSessionId = getSessionId();
      if (deletedSessionId === currentSessionId) {
        // Keep the page bound to a concrete no-user session after deleting the
        // active chat so history loading can mint the replacement immediately.
        startFreshChat({ replace: true });
      }
    },
    onError: (err) => {
      setError(`Delete failed: ${getErrorMessage(err)}`);
    },
  });

  const ratingMutation = useMutation({
    mutationFn: (payload: {
      message: ChatMessage;
      rating: ResponseRatingValue | null;
    }) => {
      if (!payload.message.messageId) {
        throw new Error('This response cannot be rated right now.');
      }
      return rateChatResponse(auth.token, {
        sessionId: payload.message.sessionId,
        messageId: payload.message.messageId,
        userId,
        rating: payload.rating,
      });
    },
    onSuccess: (data, payload) => {
      const targetSessionId = payload.message.sessionId;
      queryClient.setQueryData<ChatHistoryUiData>(
        chatHistoryQueryKey(auth.token, targetSessionId),
        (previous) => {
          if (!previous) return previous;
          return {
            ...previous,
            messages: previous.messages.map((message) =>
              message.messageId === data.messageId
                ? { ...message, responseRating: data.rating }
                : message,
            ),
          };
        },
      );
    },
    onError: (err) => {
      setError(`Rating failed: ${getErrorMessage(err)}`);
    },
  });

  // Forward fetch errors inline rather than throwing to the page-level error
  // boundary — a failed background refetch (invalidated after each stream)
  // would otherwise tear down ChatPage and lose composer/session state.
  useEffect(() => {
    const id = contextQuery.data?.snapshot?.model?.trim() ?? '';
    if (id) setSelectedModelId(id);
  }, [contextQuery.data?.snapshot?.model]);

  useEffect(() => {
    if (launchAgentId && launchAgentSessionIdRef.current === sessionId) {
      setSelectedAgentId(launchAgentId);
      return;
    }
    setSelectedAgentId(null);
  }, [launchAgentId, sessionId]);

  useEffect(() => {
    if (!historyQuery.error) return;
    setError(getErrorMessage(historyQuery.error));
  }, [historyQuery.error, setError]);

  useEffect(() => {
    if (historyQuery.data?.bootstrapAutostart?.status !== 'starting') return;
    if (historyQuery.isFetching) return;
    const timer = window.setTimeout(() => {
      void historyQuery.refetch();
    }, BOOTSTRAP_AUTOSTART_REFETCH_MS);
    return () => window.clearTimeout(timer);
  }, [
    historyQuery.data?.bootstrapAutostart?.status,
    historyQuery.isFetching,
    historyQuery.refetch,
  ]);

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
    if (historyQuery.isPending || historyQuery.fetchStatus !== 'idle') return;
    if (historyQuery.data?.requestedSessionId !== sessionId) return;
    const resolved = historyQuery.data?.resolvedSessionId;
    if (!resolved || resolved === sessionId) return;
    void navigateToSession(resolved, { replace: true });
  }, [
    historyQuery.data?.requestedSessionId,
    historyQuery.data?.resolvedSessionId,
    historyQuery.fetchStatus,
    historyQuery.isPending,
    sessionId,
    navigateToSession,
  ]);

  const branchInfoMap = useMemo(
    () => buildBranchInfoMap(messages, branchFamilies),
    [messages, branchFamilies],
  );

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !stream.isStreaming && sessionId) {
      void queryClient.invalidateQueries({
        queryKey: chatContextQueryKey(auth.token, sessionId),
      });
    }
    wasStreamingRef.current = stream.isStreaming;
  }, [stream.isStreaming, queryClient, auth.token, sessionId]);

  // Reset pin state and instantly snap to the latest message on session
  // switch so a long history doesn't crawl by under a smooth animation.
  useEffect(() => {
    if (!sessionId) return;
    resetToBottom();
  }, [sessionId, resetToBottom]);

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
          queryFn: () =>
            loadChatHistoryUi(auth.token, branch.sessionId, userId),
        });
        // Bind the ref before sending so the stream captures the branch's
        // sessionId even if React hasn't committed the URL-driven re-render yet.
        await switchToSession(branch.sessionId);
        void stream.sendMessage(newContent, msg.media ?? []);
      } catch (err) {
        setError(getErrorMessage(err));
      }
    },
    [
      auth.token,
      queryClient,
      setError,
      switchToSession,
      stream.sendMessage,
      userId,
    ],
  );

  const handleRegenerate = useCallback(
    (msg: ChatMessage) => {
      if (!msg.replayRequest) return;
      jumpToBottom();
      void stream.sendMessage(
        msg.replayRequest.content,
        msg.replayRequest.media,
        { hideUser: true },
      );
    },
    [jumpToBottom, stream.sendMessage],
  );

  const handleApprovalAction = useCallback(
    async (action: ApprovalAction, approvalId: string) => {
      const cmd = buildApprovalCommand(action, approvalId);
      if (!cmd) return;
      setApprovalBusy(true);
      try {
        jumpToBottom();
        await stream.sendMessage(cmd, [], { hideUser: true });
      } finally {
        setApprovalBusy(false);
      }
    },
    [jumpToBottom, stream.sendMessage],
  );

  const handleRateResponse = useCallback(
    (message: ChatMessage, rating: ResponseRatingValue | null) => {
      ratingMutation.mutate({ message, rating });
    },
    [ratingMutation],
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
    [auth.token, setError],
  );

  const cleanupNoUserSessions = useCallback(
    (keepSessionId: string) => {
      void cleanupNoUserChatSessions(auth.token, {
        channelId: 'web',
        keepSessionId,
      })
        .then((data) => {
          if (data.deletedCount === 0) return;
          for (const deletedSessionId of data.deletedSessionIds) {
            queryClient.removeQueries({
              queryKey: chatHistoryQueryKey(auth.token, deletedSessionId),
            });
            queryClient.removeQueries({
              queryKey: chatContextQueryKey(auth.token, deletedSessionId),
            });
          }
          void queryClient.invalidateQueries({
            queryKey: chatRecentQueryPrefix(auth.token, userId),
          });
          void queryClient.invalidateQueries({
            queryKey: ['overview'],
            refetchType: 'none',
          });
        })
        .catch((err: unknown) => {
          console.warn('Failed to clean up no-user chat session', err);
        });
    },
    [auth.token, queryClient, userId],
  );

  const handleNewChat = useCallback(() => {
    if (stream.isActive()) {
      setError('Stop the current run before starting a new chat.');
      return;
    }
    // New Conversation intentionally creates a concrete no-user session, then
    // prunes older drafts so repeated clicks only keep the latest one.
    const nextSessionId = startFreshChat();
    cleanupNoUserSessions(nextSessionId);
    refreshRecent();
  }, [
    stream.isActive,
    startFreshChat,
    cleanupNoUserSessions,
    refreshRecent,
    setError,
  ]);

  const handleSendMessage = useCallback(
    (content: string, media: MediaItem[]) => {
      // `/app <idea>` starts an app-building conversation: the message is
      // reframed as a build request so the agent gathers requirements and then
      // builds a self-contained web app. Bare `/app` opens the Apps gallery.
      const appCommand = /^\/apps?\b[ \t]*([\s\S]*)$/i.exec(content.trim());
      if (appCommand && media.length === 0) {
        const description = appCommand[1].trim();
        if (!description) {
          void navigate({ to: '/apps' });
          return;
        }
        const sid = ensureSessionForSend();
        markAppBuildSession(sid, { kind: 'web' });
        jumpToBottom();
        void stream.sendMessage(buildAppSeed(null, description), [], {
          appBuild: true,
          appKind: 'web',
        });
        return;
      }
      const sid = ensureSessionForSend();
      // Sending re-engages the user with the live conversation — snap back so
      // their bubble and the incoming stream are visible without the "↓ Latest"
      // chip getting in the way.
      jumpToBottom();
      const appBuild = appBuildSessionsRef.current.get(sid);
      if (appBuild) {
        void stream.sendMessage(content, media, {
          appBuild: true,
          ...(appBuild.category ? { appCategory: appBuild.category } : {}),
          ...(appBuild.kind ? { appKind: appBuild.kind } : {}),
        });
        return;
      }
      void stream.sendMessage(content, media);
    },
    [
      ensureSessionForSend,
      jumpToBottom,
      navigate,
      markAppBuildSession,
      stream.sendMessage,
    ],
  );

  // Auto-send a seeded conversation (Apps builder / `/app`): when arriving at
  // `/chat?prompt=…&send=1`, fire the first message once the chat API is ready.
  const autoSentSeedRef = useRef(false);
  useEffect(() => {
    if (autoSentSeedRef.current) return;
    if (!initialChatSeed.autoSend) return;
    const seed = initialChatSeed.prompt.trim();
    if (!seed) return;
    if (!chatApiReady) return;
    // Wait for the session's initial (empty) history to settle first — sending
    // before it resolves lets the empty fetch clobber the optimistic message.
    if (!historyQuery.isFetched) return;
    autoSentSeedRef.current = true;
    // Drop the params so a refresh doesn't resend.
    window.history.replaceState(null, '', window.location.pathname);
    if (initialChatSeed.appBuild) {
      const sid = ensureSessionForSend();
      markAppBuildSession(sid, {
        category: initialChatSeed.appCategory,
        kind: initialChatSeed.appKind,
      });
    }
    handleSendMessage(seed, []);
  }, [
    initialChatSeed,
    chatApiReady,
    historyQuery.isFetched,
    ensureSessionForSend,
    markAppBuildSession,
    handleSendMessage,
  ]);

  const appendLocalCommandResult = useCallback(
    (targetSessionId: string, content: string) => {
      const text = content.trim();
      if (!text) return;
      queryClient.setQueryData<ChatHistoryUiData>(
        chatHistoryQueryKey(auth.token, targetSessionId),
        (prev) => {
          const prevMessages = prev?.messages ?? [];
          if (
            prevMessages.some(
              (message) =>
                message.role === 'command' &&
                (message.rawContent || message.content).trim() === text,
            )
          ) {
            return prev;
          }
          return {
            messages: [
              ...prevMessages,
              {
                id: nextMsgId(),
                role: 'command',
                content: text,
                rawContent: text,
                sessionId: targetSessionId,
                artifacts: [],
                replayRequest: null,
              },
            ],
            branchFamilies: prev?.branchFamilies ?? new Map(),
            requestedSessionId: prev?.requestedSessionId ?? targetSessionId,
            resolvedSessionId: targetSessionId,
            agentId: prev?.agentId ?? null,
            bootstrapAutostart: prev?.bootstrapAutostart ?? null,
          };
        },
      );
    },
    [auth.token, queryClient],
  );

  const ensureSwitchHistory = useCallback(
    async (resolvedSessionId: string) => {
      const queryKey = chatHistoryQueryKey(auth.token, resolvedSessionId);
      return queryClient
        .fetchQuery({
          queryKey,
          queryFn: () =>
            loadChatHistoryUi(auth.token, resolvedSessionId, userId),
          staleTime: 0,
        })
        .catch((err: unknown) => {
          console.warn(
            'Failed to prefetch chat history before appending switch result',
            err,
          );
          return null;
        });
    },
    [auth.token, queryClient, userId],
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
        const switchHistory = await ensureSwitchHistory(resolvedSessionId);
        appendLocalCommandResult(resolvedSessionId, result.text);
        if (resolvedSessionId !== requestedSessionId) {
          await switchToSession(resolvedSessionId, { replace: true });
        }
        void queryClient.invalidateQueries({
          queryKey: chatContextQueryKey(auth.token, resolvedSessionId),
        });
        const shouldAwaitGatewayHatching =
          commandArgs[0] === 'agent' &&
          commandArgs[1] === 'switch' &&
          switchHistory?.bootstrapAutostart?.fileName === 'BOOTSTRAP.md' &&
          (switchHistory.bootstrapAutostart.status === 'idle' ||
            switchHistory.bootstrapAutostart.status === 'starting');
        if (shouldAwaitGatewayHatching) {
          queryClient.setQueryData<ChatHistoryUiData>(
            chatHistoryQueryKey(auth.token, resolvedSessionId),
            (prev) =>
              prev
                ? {
                    ...prev,
                    bootstrapAutostart: {
                      status: 'starting',
                      fileName: 'BOOTSTRAP.md',
                    },
                  }
                : prev,
          );
          jumpToBottom();
        }
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
      ensureSwitchHistory,
      getSessionId,
      jumpToBottom,
      queryClient,
      refreshRecent,
      setError,
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
    [stream.isActive, navigateToSession, setError],
  );

  const canDeleteSession = useCallback(
    (targetSessionId: string) => {
      if (stream.activeSessionId === targetSessionId) {
        setError('Stop the current run before deleting this chat.');
        return false;
      }
      return !deleteSessionMutation.isPending;
    },
    [deleteSessionMutation.isPending, stream.activeSessionId, setError],
  );

  const handleRequestDeleteSession = useCallback(
    (target: ChatRecentSession) => {
      if (!canDeleteSession(target.sessionId)) return;
      setSessionPendingDelete(target);
    },
    [canDeleteSession],
  );

  const handleConfirmDeleteSession = useCallback(() => {
    if (!sessionPendingDelete) {
      throw new Error('Delete confirmation is missing a session.');
    }
    if (!canDeleteSession(sessionPendingDelete.sessionId)) return;
    deleteSessionMutation.mutate(sessionPendingDelete.sessionId);
  }, [canDeleteSession, deleteSessionMutation, sessionPendingDelete]);

  const handleHoverSession = useCallback(
    (targetId: string) => {
      if (targetId === getSessionId()) return;
      void queryClient.prefetchQuery({
        queryKey: chatHistoryQueryKey(auth.token, targetId),
        queryFn: () => loadChatHistoryUi(auth.token, targetId, userId),
        staleTime: 30_000,
      });
    },
    [queryClient, auth.token, getSessionId, userId],
  );

  const handleRefreshRecent = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: chatRecentQueryKey(
        auth.token,
        userId,
        trimmedSessionSearchQuery,
        recentChatScope,
      ),
    });
  }, [
    queryClient,
    auth.token,
    userId,
    trimmedSessionSearchQuery,
    recentChatScope,
  ]);

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
  }, [auth.token, getSessionId, userId, setError]);

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

  const isEmpty = visibleMessages.length === 0;
  const isSwitchingSession = historyQuery.isFetching;

  const sidebarProps = {
    sessions: recentSessions,
    activeSessionId: sessionId,
    onNewChat: handleNewChat,
    onOpenSession: handleOpenSession,
    onHoverSession: handleHoverSession,
    onRequestDeleteSession: handleRequestDeleteSession,
    deleteDisabled: deleteSessionMutation.isPending,
    isPending: isSwitchingSession,
    searchQuery: sessionSearchQuery,
    onSearchQueryChange: setSessionSearchQuery,
    recentScope: recentChatScope,
    onRecentScopeChange: setRecentChatScope,
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
            <ContextRing
              sessionId={sessionId}
              token={auth.token}
              enabled={chatApiReady}
            />
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
            <ViewSwitchNav items={viewSwitchItems} />
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
              <h1 className={css.greeting}>{emptyChatHeader}</h1>
            </div>
          ) : (
            <div className={css.messageArea} ref={messageAreaRef}>
              <div className={css.messageList} ref={messageListRef}>
                {visibleMessages.map((msg) =>
                  editingId === msg.id &&
                  msg.role !== 'thinking' &&
                  msg.role !== 'trace' &&
                  msg.role !== 'draft' ? (
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
                      onRate={handleRateResponse}
                      ratingBusy={
                        ratingMutation.isPending &&
                        ratingMutation.variables?.message.id === msg.id
                      }
                      skillInvocationTargets={skillInvocationTargets}
                      onApprovalAction={handleApprovalAction}
                      approvalBusy={approvalBusy}
                      branchInfo={branchInfoMap.get(msg.id) ?? null}
                      onBranchNav={handleBranchNav}
                    />
                  ),
                )}
              </div>
            </div>
          )}
          {!isEmpty && !isPinned ? (
            <button
              type="button"
              className={css.jumpToLatest}
              onClick={jumpToBottom}
              aria-label="Jump to latest message"
            >
              <span aria-hidden="true">↓</span>
              <span>Latest</span>
            </button>
          ) : null}

          {error ? (
            <div
              className={`${css.errorBanner} ${
                errorExiting ? css.errorBannerExiting : ''
              }`}
            >
              {error}
            </div>
          ) : null}

          <Composer
            isStreaming={stream.isStreaming}
            onSend={handleSendMessage}
            onStop={() => void stream.stopRequest()}
            onUploadFiles={handleUploadFiles}
            token={auth.token}
            agents={agentOptions}
            selectedAgentId={effectiveAgentId}
            onAgentSwitch={(agentId) => void handleAgentSwitch(agentId)}
            models={modelOptions}
            selectedModelId={selectedModelId}
            onModelSwitch={(modelId) => void handleModelSwitch(modelId)}
            initialValue={initialComposerPrompt}
            routing={contextQuery.data?.snapshot?.routing}
          />
        </div>
        <Dialog
          open={sessionPendingDelete !== null}
          onOpenChange={(open) => {
            if (!open && !deleteSessionMutation.isPending) {
              setSessionPendingDelete(null);
            }
          }}
        >
          <DialogContent
            size="sm"
            role="alertdialog"
            preventCloseOnOutsideClick={deleteSessionMutation.isPending}
          >
            <DialogHeader>
              <DialogTitle>Delete session?</DialogTitle>
              <DialogDescription>
                This permanently removes the conversation and associated session
                records.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="ghost"
                disabled={deleteSessionMutation.isPending}
                render={<DialogClose>Cancel</DialogClose>}
              />
              <Button
                variant="danger"
                disabled={deleteSessionMutation.isPending}
                onClick={handleConfirmDeleteSession}
              >
                {deleteSessionMutation.isPending ? 'Deleting...' : 'Delete'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={previewApp !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewApp(null);
          }}
        >
          <DialogContent
            className={css.appPreviewDialog}
            aria-label="App preview"
          >
            <div className={css.appPreviewHeader}>
              <DialogTitle className={css.appPreviewTitle}>
                {previewApp?.title}
              </DialogTitle>
              <div className={css.appPreviewActions}>
                <button
                  type="button"
                  className={css.appPreviewLink}
                  onClick={() => {
                    setPreviewApp(null);
                    void navigate({ to: '/apps' });
                  }}
                >
                  View in Apps
                </button>
                {previewApp && previewAppToken ? (
                  <a
                    className={css.appPreviewLink}
                    href={appViewUrl(previewApp.id, previewAppToken)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in new tab ↗
                  </a>
                ) : null}
                <DialogClose className={css.appPreviewLink}>Close</DialogClose>
              </div>
            </div>
            {previewApp && previewAppToken ? (
              <LiveAppFrame
                appId={previewApp.id}
                className={css.appPreviewFrame}
                title={previewApp.title}
                token={previewAppToken}
              />
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </ChatSidebarProvider>
  );
}
