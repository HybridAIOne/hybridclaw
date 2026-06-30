import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { generateWebSessionId, storeSessionId } from '../../lib/chat-helpers';

export interface UseChatSessionReturn {
  /** URL session id, or a generated session id while bare `/chat` catches up. */
  sessionId: string;
  getSessionId: () => string;
  navigateToSession: (
    id: string,
    opts?: { replace?: boolean },
  ) => Promise<void>;
  /**
   * Imperatively bind the ref-backed current session id AND navigate to it.
   * Use this instead of `navigateToSession` when the caller plans to read
   * `getSessionId()` on the very next line — it closes the render-lag window
   * where `sessionIdRef` would otherwise still point at the previous session.
   */
  switchToSession: (id: string, opts?: { replace?: boolean }) => Promise<void>;
  startFreshChat: (opts?: { replace?: boolean }) => string;
  ensureSessionForSend: () => string;
  isLocallyCreatedSession: (id: string) => boolean;
  handleSessionIdCorrection: (serverSessionId: string) => void;
}

/**
 * Owns the chat session-id lifecycle: URL param, generated session for the
 * bare `/chat` route, localStorage persistence, and navigation between
 * sessions.
 */
export function useChatSession(): UseChatSessionReturn {
  const params = useParams({ strict: false }) as { sessionId?: string };
  const navigate = useNavigate();
  const urlSessionId = params.sessionId;

  // Generated id for the bare `/chat` route. The URL is replaced with it as
  // soon as the hook mounts, so `/chat` stays a transition state.
  const draftSessionIdRef = useRef<string | null>(null);
  const locallyCreatedSessionIdsRef = useRef<Set<string>>(new Set());
  if (!urlSessionId && !draftSessionIdRef.current) {
    const newId = generateWebSessionId();
    draftSessionIdRef.current = newId;
    locallyCreatedSessionIdsRef.current.add(newId);
  }
  const sessionId = urlSessionId ?? draftSessionIdRef.current ?? '';
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (urlSessionId) draftSessionIdRef.current = null;
  }, [urlSessionId]);

  useEffect(() => {
    if (sessionId) storeSessionId(sessionId);
  }, [sessionId]);

  const getSessionId = useCallback(() => sessionIdRef.current, []);

  const navigateToSession = useCallback(
    (id: string, opts?: { replace?: boolean }) =>
      navigate({
        to: '/chat/$sessionId',
        params: { sessionId: id },
        ...opts,
      }),
    [navigate],
  );

  useEffect(() => {
    if (urlSessionId || !sessionId) return;
    void navigateToSession(sessionId, { replace: true });
  }, [navigateToSession, sessionId, urlSessionId]);

  const switchToSession = useCallback(
    (id: string, opts?: { replace?: boolean }) => {
      draftSessionIdRef.current = id;
      sessionIdRef.current = id;
      return navigateToSession(id, opts);
    },
    [navigateToSession],
  );

  const startFreshChat = useCallback(
    (opts?: { replace?: boolean }): string => {
      const newId = generateWebSessionId();
      draftSessionIdRef.current = newId;
      sessionIdRef.current = newId;
      locallyCreatedSessionIdsRef.current.add(newId);
      void navigateToSession(newId, opts);
      return newId;
    },
    [navigateToSession],
  );

  const ensureSessionForSend = useCallback((): string => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const newId = generateWebSessionId();
    draftSessionIdRef.current = newId;
    sessionIdRef.current = newId;
    locallyCreatedSessionIdsRef.current.add(newId);
    void navigateToSession(newId, { replace: true });
    return newId;
  }, [navigateToSession]);

  const isLocallyCreatedSession = useCallback(
    (id: string) => locallyCreatedSessionIdsRef.current.has(id),
    [],
  );

  const handleSessionIdCorrection = useCallback(
    (serverSessionId: string) => {
      if (serverSessionId === sessionIdRef.current) return;
      void navigateToSession(serverSessionId, { replace: true });
    },
    [navigateToSession],
  );

  return {
    sessionId,
    getSessionId,
    navigateToSession,
    switchToSession,
    startFreshChat,
    ensureSessionForSend,
    isLocallyCreatedSession,
    handleSessionIdCorrection,
  };
}
