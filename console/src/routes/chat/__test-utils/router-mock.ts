import { vi } from 'vitest';

export interface TestRouter {
  reset(): void;
  setSessionId(id: string | null): void;
  navigate: ReturnType<typeof vi.fn>;
  lastTo: string | null;
  lastReplace: boolean | null;
}

export interface RouterMockModule {
  useNavigate: () => TestRouter['navigate'];
  useParams: () => { sessionId: string | null };
  __testRouter: TestRouter;
}

/**
 * Reactive `@tanstack/react-router` mock for chat tests. `useParams` is
 * backed by `useSyncExternalStore`, so tests can mutate the session id
 * via `__testRouter.setSessionId(id)` or `navigate(...)` and consumers
 * re-render.
 */
export async function createRouterMock(
  initialSessionId: string | null,
): Promise<RouterMockModule> {
  const React = await vi.importActual<typeof import('react')>('react');
  const store = {
    snapshot: { sessionId: initialSessionId },
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
      store.snapshot = { sessionId: initialSessionId };
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
}
