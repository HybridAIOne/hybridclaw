import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';
import { generateWebSessionId, storeSessionId } from '../../lib/chat-helpers';

interface UseChatSessionOptions {
  getDefaultAgentId: () => string;
}

export interface UseChatSessionReturn {
  /** Empty string when the URL is `/chat` and no draft has been minted yet. */
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
  startFreshChat: () => void;
  ensureSessionForSend: () => void;
  handleSessionIdCorrection: (serverSessionId: string) => void;
}

/**
 * Owns the chat session-id lifecycle: URL param, lazy draft for the bare
 * `/chat` route, localStorage persistence, and navigation between sessions.
 */
export function useChatSession(
  options: UseChatSessionOptions,
): UseChatSessionReturn {
  const { getDefaultAgentId } = options;
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { sessionId?: string };
  const urlSessionId = params.sessionId;

  // Lazily-generated id for the bare `/chat` route — the first send targets
  // this id before the URL catches up in the next render.
  const draftSessionIdRef = useRef<string | null>(null);
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

  const switchToSession = useCallback(
    (id: string, opts?: { replace?: boolean }) => {
      draftSessionIdRef.current = id;
      sessionIdRef.current = id;
      return navigateToSession(id, opts);
    },
    [navigateToSession],
  );

  const startFreshChat = useCallback(() => {
    draftSessionIdRef.current = null;
    void navigate({ to: '/chat' });
  }, [navigate]);

  const ensureSessionForSend = useCallback(() => {
    if (sessionIdRef.current) return;
    const newId = generateWebSessionId(getDefaultAgentId());
    draftSessionIdRef.current = newId;
    sessionIdRef.current = newId;
    void navigateToSession(newId, { replace: true });
  }, [navigateToSession, getDefaultAgentId]);

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
    handleSessionIdCorrection,
  };
}
