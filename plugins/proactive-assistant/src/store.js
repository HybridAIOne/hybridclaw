/**
 * The feed's state for the one HybridAI account this gateway signs in as:
 * settings, source cursors and suggestions, so a check resumes where the last
 * one stopped after a restart.
 *
 * Kept in the runtime home, outside every agent workspace: suggestions are
 * derived from the user's mail, and an agent's file tools must not reach them.
 * NOT a conversation store and never a copy of mail or calendar content; only
 * what the assessment wrote is kept.
 */
import fs from 'node:fs';
import path from 'node:path';

// 14 days / 100 suggestions (engineering choice, 2026-09-30): a suggestion
// older than two weeks is stale advice, and the app shows at most 100.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS = 100;

export function defaultSettings() {
  return {
    enabled: false,
    goals: '',
    quiet_start: 22,
    quiet_end: 8,
    time_zone: 'UTC',
  };
}

export function emptyCursor() {
  return { history_id: null, synced_at: null, horizon: null };
}

export function emptyState() {
  return {
    version: 1,
    // Whose connectors the gateway's HybridAI credential reads, and a
    // fingerprint of that credential, so a changed sign-in is noticed.
    account: null,
    // Bumped by every settings change; a check that started before it
    // discards its result.
    revision: 0,
    settings: defaultSettings(),
    language: 'en',
    cursor: emptyCursor(),
    sources: { gmail: false, calendar: false },
    suggestions: [],
    last_checked_at: null,
    error: null,
    assessment_failures: 0,
  };
}

/** Drops what is past retention. True when something was dropped. */
export function prune(state, now) {
  const before = state.suggestions.length;
  const cutoff = now - RETENTION_MS;
  state.suggestions = state.suggestions
    .filter((item) => Date.parse(item.created_at) > cutoff)
    .slice(-MAX_SUGGESTIONS);
  return state.suggestions.length !== before;
}

export function createStore(homeDir, logger) {
  const directory = path.join(homeDir, 'proactive-assistant');
  const filePath = path.join(directory, 'state.json');

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.suggestions)) {
        return { ...emptyState(), ...parsed };
      }
    } catch {
      // Falls through to the reset below.
    }
    // Writes are atomic, so this is a file from another version or a manual
    // edit. Starting over loses open suggestions and re-takes the bookmarks;
    // refusing to start would end the feed until someone deletes the file.
    logger.warn('Proactive state was unreadable and has been reset.');
    return emptyState();
  }

  function save(state) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }

  return { load, save };
}
