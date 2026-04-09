import fs from 'node:fs';
import path from 'node:path';

const STATE_VERSION = 1;

function createEmptyState() {
  return {
    version: STATE_VERSION,
    sessions: {},
    honchoSessions: {},
  };
}

export function loadPersistedState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createEmptyState();
    return {
      version: STATE_VERSION,
      sessions:
        parsed.sessions &&
        typeof parsed.sessions === 'object' &&
        !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
      honchoSessions:
        parsed.honchoSessions &&
        typeof parsed.honchoSessions === 'object' &&
        !Array.isArray(parsed.honchoSessions)
          ? parsed.honchoSessions
          : {},
    };
  } catch {
    return createEmptyState();
  }
}

export function savePersistedState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  fs.renameSync(tempPath, statePath);
}

export function getSessionState(state, sessionId) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      historyBackfilled: false,
      lastSyncedMessageId: 0,
      turnCount: 0,
      lastContextTurn: 0,
      lastDialecticTurn: 0,
      promptInjections: 0,
    };
  }
  if (typeof state.sessions[sessionId].historyBackfilled !== 'boolean') {
    state.sessions[sessionId].historyBackfilled = false;
  }
  return state.sessions[sessionId];
}

export function getHonchoSessionState(state, honchoSessionId) {
  if (!state.honchoSessions[honchoSessionId]) {
    state.honchoSessions[honchoSessionId] = {
      seededSources: [],
    };
  }
  return state.honchoSessions[honchoSessionId];
}
