/**
 * Session state dir: the small facts a session's next worker must inherit
 * when this worker dies (idle timeout, provider switch, pool eviction, crash).
 *
 * Lives in the owning agent/scope's persistent state workspace under
 * `.hybridclaw-runtime/sessions/<sha256 of the session id>/`, so it survives
 * worker kills, stays out of agent archives, and goes with agent state on
 * `/reset`. Like `.session-transcripts/`, entries are not pruned. NOT the
 * gateway's session store (conversation and settings stay in SQLite), and
 * never a home for secrets or environment snapshots. One worker serves a
 * session at a time, so writes take no lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../shared/atomic-write.js';
import { sessionStatePath as workspaceSessionStatePath } from '../shared/turn-checkpoint.js';
import { WORKSPACE_STATE_ROOT } from './runtime-paths.js';

// Stands in for a session id in paths and records, which keeps peer ids such
// as phone numbers out of agent-readable files.
export { sessionStateKey } from '../shared/turn-checkpoint.js';

export function sessionStatePath(sessionId: string, name: string): string {
  return workspaceSessionStatePath(WORKSPACE_STATE_ROOT, sessionId, name);
}

export function ensureSessionStateDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

function readValues(filePath: string, required = false): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if (required && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; values?: unknown };
    if (
      required &&
      (parsed.version !== 1 ||
        !Array.isArray(parsed.values) ||
        !parsed.values.every((value: unknown) => typeof value === 'string'))
    ) {
      throw new Error('Invalid required session guard state');
    }
    return Array.isArray(parsed.values)
      ? parsed.values.filter((value) => typeof value === 'string')
      : [];
  } catch (error) {
    if (required) throw error;
    console.error(`[session-state] ignoring unreadable ${filePath}`);
    return [];
  }
}

/**
 * A string set whose additions are written through to a file in the session
 * state dir, so a restarted worker starts from what earlier workers recorded.
 * Additions and deletions persist; unbound, it is a plain in-memory set.
 * Required guard stores reject unreadable state and latch persistence failures.
 */
export class SessionStateSet extends Set<string> {
  private filePath: string | null = null;
  private failure?: Error;

  constructor(
    private readonly name: string,
    private readonly required = false,
  ) {
    super();
  }

  bindSession(sessionId: string): void {
    const filePath = sessionId ? sessionStatePath(sessionId, this.name) : null;
    if (filePath === this.filePath) {
      if (this.failure) throw this.failure;
      return;
    }
    const values = filePath ? readValues(filePath, this.required) : [];
    this.filePath = filePath;
    this.failure = undefined;
    super.clear();
    for (const value of values) super.add(value);
  }

  override add(value: string): this {
    if (this.failure) throw this.failure;
    if (this.has(value)) return this;
    super.add(value);
    if (this.filePath) this.persist(this.filePath);
    return this;
  }

  override delete(value: string): boolean {
    if (this.failure) throw this.failure;
    const deleted = super.delete(value);
    if (deleted && this.filePath) this.persist(this.filePath);
    return deleted;
  }

  private persist(filePath: string): void {
    try {
      ensureSessionStateDir(filePath);
      writeFileAtomic(
        filePath,
        JSON.stringify({ version: 1, values: [...this] }),
        { mode: 0o600 },
      );
    } catch (error) {
      if (this.required) {
        this.failure = new Error(
          'Required session guard state could not be persisted',
        );
        throw this.failure;
      }
      // The set still holds the value for this worker; only a restart loses it.
      console.error(`[session-state] failed to persist ${this.name}:`, error);
    }
  }
}
