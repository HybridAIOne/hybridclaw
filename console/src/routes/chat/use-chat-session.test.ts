import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestRouter } from './__test-utils/router-mock';

vi.mock('@tanstack/react-router', async () => {
  const { createRouterMock } = await import('./__test-utils/router-mock');
  return createRouterMock(null);
});

import { useChatSession } from './use-chat-session';

async function getTestRouter(): Promise<TestRouter> {
  const mod = (await import('@tanstack/react-router')) as unknown as {
    __testRouter: TestRouter;
  };
  return mod.__testRouter;
}

function ensureLocalStorage() {
  if (typeof globalThis.localStorage?.clear === 'function') return;
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  } satisfies Storage;
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
  });
  Object.defineProperty(window, 'localStorage', {
    value: storage,
    configurable: true,
  });
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
    ensureLocalStorage();
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

    await act(async () => {
      router.setSessionId('session-a');
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

  it('switchToSession updates getSessionId synchronously before navigation resolves', async () => {
    const router = await getTestRouter();
    router.setSessionId('session-origin');
    const { result } = setup();
    expect(result.current.getSessionId()).toBe('session-origin');

    // Kick off the navigation but do NOT await it — simulate a caller that
    // reads getSessionId() on the very next synchronous line.
    act(() => {
      void result.current.switchToSession('session-branch');
    });

    expect(result.current.getSessionId()).toBe('session-branch');
    expect(router.lastTo).toBe('/chat/$sessionId');
  });

  it('clears the draft once the URL catches up to a real session', async () => {
    const router = await getTestRouter();
    const { result, rerender } = setup();

    act(() => {
      result.current.ensureSessionForSend();
    });
    const minted = result.current.getSessionId();

    // URL catches up
    await act(async () => {
      router.setSessionId(minted);
      rerender();
      await Promise.resolve();
    });

    // URL navigates to a different session — the old draft must not bleed in
    act(() => {
      router.setSessionId('session-other');
      rerender();
    });

    expect(result.current.sessionId).toBe('session-other');
  });
});
