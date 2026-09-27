/**
 * Session state dir: the small facts a session's next worker must inherit
 * when this worker dies (idle timeout, provider switch, pool eviction, crash).
 *
 * Lives in the host-mounted workspace under
 * `.hybridclaw-runtime/sessions/<sha256 of the session id>/`, so it survives
 * worker kills, stays out of agent archives, and goes with the workspace on
 * `/reset`. Like `.session-transcripts/`, entries are not pruned. NOT the
 * gateway's session store (conversation and settings stay in SQLite), and
 * never a home for secrets or environment snapshots. One worker serves a
 * session at a time, so writes take no lock.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from './runtime-paths.js';

const SESSION_STATE_ROOT = path.join(
  WORKSPACE_ROOT,
  '.hybridclaw-runtime',
  'sessions',
);

// Stands in for a session id in paths and records, which keeps peer ids such
// as phone numbers out of agent-readable files.
export function sessionStateKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function sessionStatePath(sessionId: string, name: string): string {
  return path.join(SESSION_STATE_ROOT, sessionStateKey(sessionId), name);
}

export function ensureSessionStateDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function readValues(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { values?: unknown };
    return Array.isArray(parsed.values)
      ? parsed.values.filter((value) => typeof value === 'string')
      : [];
  } catch {
    console.error(`[session-state] ignoring unreadable ${filePath}`);
    return [];
  }
}

/**
 * A string set whose additions are written through to a file in the session
 * state dir, so a restarted worker starts from what earlier workers recorded.
 * Only `add` persists; unbound (no session yet), it is a plain in-memory set.
 */
export class SessionStateSet extends Set<string> {
  private filePath: string | null = null;

  constructor(private readonly name: string) {
    super();
  }

  bindSession(sessionId: string): void {
    const filePath = sessionId ? sessionStatePath(sessionId, this.name) : null;
    if (filePath === this.filePath) return;
    this.filePath = filePath;
    super.clear();
    for (const value of filePath ? readValues(filePath) : []) super.add(value);
  }

  override add(value: string): this {
    if (this.has(value)) return this;
    super.add(value);
    if (this.filePath) this.persist(this.filePath);
    return this;
  }

  private persist(filePath: string): void {
    try {
      ensureSessionStateDir(filePath);
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(
        tmpPath,
        JSON.stringify({ version: 1, values: [...this] }),
        { mode: 0o600 },
      );
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      // The set still holds the value for this worker; only a restart loses it.
      console.error(`[session-state] failed to persist ${this.name}:`, error);
    }
  }
}
