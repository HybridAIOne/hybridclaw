/**
 * Audit writers and per-session lookups share one exact, hashed directory.
 * Unlike audit-trail, this module neither appends nor verifies hash chains.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config/config.js';
import { sessionDirectoryName } from '../utils/session-directory.js';

const SESSION_ID_FILE = '.session-id';

export function getAuditSessionDir(
  sessionId: string,
  dataDir = DATA_DIR,
): string {
  return path.join(dataDir, 'audit', sessionDirectoryName(sessionId));
}

export function getAuditWirePath(
  sessionId: string,
  dataDir = DATA_DIR,
): string {
  return path.join(getAuditSessionDir(sessionId, dataDir), 'wire.jsonl');
}

/** Adoption keeps the original hash-chain bytes but changes the directory owner. */
export function recordAuditSessionRename(sessionId: string): void {
  fs.writeFileSync(
    path.join(getAuditSessionDir(sessionId), SESSION_ID_FILE),
    sessionId,
    { mode: 0o600 },
  );
}

export function readAuditSessionId(sessionDir: string): string | null {
  try {
    const sessionId = fs.readFileSync(
      path.join(sessionDir, SESSION_ID_FILE),
      'utf8',
    );
    if (sessionDirectoryName(sessionId) !== path.basename(sessionDir))
      throw new Error('Audit session identity does not match its directory');
    return sessionId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const first = fs
    .readFileSync(path.join(sessionDir, 'wire.jsonl'), 'utf8')
    .split('\n', 1)[0];
  try {
    const parsed = JSON.parse(first) as { sessionId?: unknown } | null;
    return typeof parsed?.sessionId === 'string' ? parsed.sessionId : null;
  } catch {
    return null;
  }
}
