/**
 * Older history shares the live-message cache, but never replaces newer output.
 * Unlike bottom-following, a prepend anchors the existing visible DOM node;
 * requests and scroll snapshots belong only to this mounted session viewport.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/button';
import { getErrorMessage } from '../../lib/error-message';
import {
  type ChatHistoryUiData,
  chatHistoryQueryKey,
  loadChatHistoryUi,
  prependChatHistory,
} from './chat-history-query';
import pagerCss from './chat-history-viewport.module.css';
import css from './chat-page.module.css';

interface Props {
  token: string;
  sessionId: string;
  userId: string;
  agentId?: string;
  history: ChatHistoryUiData | undefined;
  scrollRef: (element: HTMLDivElement | null) => void;
  contentRef: (element: HTMLDivElement | null) => void;
  onPrepend: () => void;
  children: ReactNode;
}

export function ChatHistoryViewport({
  token,
  sessionId,
  userId,
  agentId,
  history,
  scrollRef,
  contentRef,
  onPrepend,
  children,
}: Props) {
  const queryClient = useQueryClient();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  const previousTop = useRef(0);
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      scrollerRef.current = element;
      scrollRef(element);
      previousTop.current = element?.scrollTop ?? 0;
    },
    [scrollRef],
  );
  const attachContent = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
      contentRef(element);
    },
    [contentRef],
  );
  const anchor = useRef<{
    element: Element;
    top: number;
    history: ChatHistoryUiData;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const snapshot = anchor.current;
    const scroller = scrollerRef.current;
    if (!snapshot || !scroller || snapshot.history === history) return;
    if (snapshot.element.isConnected) {
      scroller.scrollTop +=
        snapshot.element.getBoundingClientRect().top - snapshot.top;
    }
    anchor.current = null;
  });

  async function loadOlder() {
    const key = chatHistoryQueryKey(token, sessionId);
    const before = queryClient.getQueryData<ChatHistoryUiData>(key)?.nextCursor;
    if (!before || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const older = await loadChatHistoryUi(
        token,
        sessionId,
        userId,
        agentId,
        before,
      );
      if (!active.current) return;
      const current = queryClient.getQueryData<ChatHistoryUiData>(key);
      // A refresh can change the cursor while this request is outstanding.
      if (
        !current ||
        current.nextCursor !== before ||
        older.resolvedSessionId !== current.resolvedSessionId
      )
        return;
      const scroller = scrollerRef.current;
      const viewportTop = scroller?.getBoundingClientRect().top ?? 0;
      const element = Array.from(listRef.current?.children ?? []).find(
        (child) => child.getBoundingClientRect().bottom > viewportTop,
      );
      if (element) {
        anchor.current = {
          element,
          top: element.getBoundingClientRect().top,
          history: current,
        };
      }
      onPrepend();
      queryClient.setQueryData(key, prependChatHistory(older, current));
    } catch (cause) {
      if (active.current) setError(getErrorMessage(cause));
    } finally {
      inFlight.current = false;
      if (active.current) setLoading(false);
    }
  }

  return (
    <div
      className={css.messageArea}
      ref={attachScroller}
      onScroll={(event) => {
        const element = event.currentTarget;
        const movingUp = element.scrollTop < previousTop.current;
        previousTop.current = element.scrollTop;
        // 80px (Codex choice, 2026-11-11): page near the top on upward
        // movement; eager prefetch without scrolling is deferred.
        if (movingUp && element.scrollTop <= 80 && !error) {
          void loadOlder();
        }
      }}
    >
      <div className={pagerCss.historyPager}>
        {history?.nextCursor ? (
          <Button
            variant="ghost"
            disabled={loading}
            onClick={() => void loadOlder()}
          >
            {loading ? 'Loading older messages…' : 'Load older messages'}
          </Button>
        ) : history?.hasLoadedOlder ? (
          <span>Beginning of conversation</span>
        ) : null}
        {error ? (
          <div role="alert">Could not load older messages: {error}</div>
        ) : null}
      </div>
      <div className={css.messageList} ref={attachContent}>
        {children}
      </div>
    </div>
  );
}
