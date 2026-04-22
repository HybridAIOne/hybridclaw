import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestRouter {
  reset(): void;
  setSessionId(id: string | null): void;
  navigate: ReturnType<typeof vi.fn>;
  lastTo: string | null;
  lastReplace: boolean | null;
}

vi.mock('@tanstack/react-router', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  const store = {
    snapshot: { sessionId: null as string | null },
  };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  const update = (id: string | null) => {
    if (id === store.snapshot.sessionId) return;
    store.snapshot = { sessionId: id };
    emit();
  };
  const navigate = vi.fn(
    async (opts: {
      to: string;
      params?: { sessionId?: string };
      replace?: boolean;
    }) => {
      testRouter.lastTo = opts.to;
      testRouter.lastReplace = opts.replace ?? false;
      if (opts.to === '/chat') {
        update(null);
      } else if (opts.to === '/chat/$sessionId') {
        update(opts.params?.sessionId ?? null);
      }
    },
  );
  const testRouter: TestRouter = {
    reset() {
      store.snapshot = { sessionId: null };
      navigate.mockClear();
      testRouter.lastTo = null;
      testRouter.lastReplace = null;
    },
    setSessionId: update,
    navigate,
    lastTo: null,
    lastReplace: null,
  };
  return {
    useNavigate: () => navigate,
    useParams: () =>
      React.useSyncExternalStore(
        (cb) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
        () => store.snapshot,
        () => store.snapshot,
      ),
    __testRouter: testRouter,
  };
});

import { useChatSession } from './use-chat-session';

async function getTestRouter(): Promise<TestRouter> {
  const mod = (await import('@tanstack/react-router')) as unknown as {
    __testRouter: TestRouter;
  };
  return mod.__testRouter;
}

function setup() {
  return renderHook(() =>
    useChatSession({
      getDefaultAgentId: () => 'main',
    }),
  );
}

describe('useChatSession', () => {
  beforeEach(async () => {
    localStorage.clear();
    (await getTestRouter()).reset();
  });

  it('returns empty sessionId when the URL is bare and no draft has been minted', () => {
    const { result } = setup();
    expect(result.current.sessionId).toBe('');
    expect(result.current.getSessionId()).toBe('');
  });

  it('returns the URL sessionId when the `/chat/$sessionId` route is active', async () => {
    const router = await getTestRouter();
    router.setSessionId('session-from-url');

    const { result } = setup();
    expect(result.current.sessionId).toBe('session-from-url');
    expect(result.current.getSessionId()).toBe('session-from-url');
  });

  it('persists the sessionId to localStorage whenever it becomes truthy', async () => {
    const router = await getTestRouter();
    const { result } = setup();
    expect(localStorage.getItem('hybridclaw_session')).toBeNull();

    router.setSessionId('session-a');
    // Flush effect
    await act(async () => {
      await Promise.resolve();
    });

    expect(localStorage.getItem('hybridclaw_session')).toBe('session-a');
    expect(result.current.sessionId).toBe('session-a');
  });

  it('ensureSessionForSend mints a draft, updates getSessionId immediately, and navigates replace', async () => {
    const router = await getTestRouter();
    const { result } = setup();

    act(() => {
      result.current.ensureSessionForSend();
    });

    const minted = result.current.getSessionId();
    expect(minted).not.toBe('');
    expect(minted.startsWith('agent:main:channel:web:chat:dm:peer:')).toBe(
      true,
    );
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.lastTo).toBe('/chat/$sessionId');
    expect(router.lastReplace).toBe(true);
  });

  it('ensureSessionForSend is a no-op when a sessionId is already present', async () => {
    const router = await getTestRouter();
    router.setSessionId('session-existing');
    const { result } = setup();

    act(() => {
      result.current.ensureSessionForSend();
    });

    expect(router.navigate).not.toHaveBeenCalled();
    expect(result.current.getSessionId()).toBe('session-existing');
  });

  it('startFreshChat clears the draft and navigates to `/chat`', async () => {
    const router = await getTestRouter();
    const { result } = setup();

    act(() => {
      result.current.ensureSessionForSend();
    });
    expect(result.current.getSessionId()).not.toBe('');
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      result.current.startFreshChat();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(router.lastTo).toBe('/chat');
    expect(result.current.sessionId).toBe('');
  });

  it('handleSessionIdCorrection navigates replace when the server id differs', async () => {
    const router = await getTestRouter();
    router.setSessionId('session-local');
    const { result } = setup();

    act(() => {
      result.current.handleSessionIdCorrection('session-canonical');
    });

    expect(router.lastTo).toBe('/chat/$sessionId');
    expect(router.lastReplace).toBe(true);
  });

  it('handleSessionIdCorrection is a no-op when the server id already matches', async () => {
    const router = await getTestRouter();
    router.setSessionId('session-same');
    const { result } = setup();

    act(() => {
      result.current.handleSessionIdCorrection('session-same');
    });

    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('clears the draft once the URL catches up to a real session', async () => {
    const router = await getTestRouter();
    const { result, rerender } = setup();

    act(() => {
      result.current.ensureSessionForSend();
    });
    const minted = result.current.getSessionId();

    // URL catches up
    router.setSessionId(minted);
    rerender();
    await act(async () => {
      await Promise.resolve();
    });

    // URL navigates to a different session — the old draft must not bleed in
    router.setSessionId('session-other');
    rerender();

    expect(result.current.sessionId).toBe('session-other');
  });
});
