const SESSION_KEY = 'hybridclaw_session';

function getActiveSessionId(): string {
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
}
