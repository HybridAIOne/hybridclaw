import { useSyncExternalStore } from 'react';

const SESSION_KEY = 'hybridclaw_session';

type Listener = () => void;

const listeners = new Set<Listener>();

export function getActiveSessionId(): string {
  try {
    return localStorage.getItem(SESSION_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setActiveSessionId(id: string): void {
  const current = getActiveSessionId();
  if (current === id) return;
  try {
    if (id) {
      localStorage.setItem(SESSION_KEY, id);
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
  for (const listener of listeners) listener();
}

export function subscribeActiveSessionId(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useActiveSessionId(): string {
  return useSyncExternalStore(
    subscribeActiveSessionId,
    getActiveSessionId,
    getActiveSessionId,
  );
}
