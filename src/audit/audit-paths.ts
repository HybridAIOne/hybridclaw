/**
 * Audit writers and per-session lookups share one exact, hashed directory.
 * A legacy directory every record of which names the session moves there on
 * first use; any other legacy log stays where it is.
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
  const root = path.join(dataDir, 'audit');
  const target = path.join(root, sessionDirectoryName(sessionId));
  if (!fs.existsSync(target)) adoptLegacyAuditDir(root, sessionId, target);
  return target;
}

// Installs can skip the release that moved these logs. A fresh chain beside an
// old one restarts at seq 1, and mirrors keyed by (session, seq) drop it.
function adoptLegacyAuditDir(
  root: string,
  sessionId: string,
  target: string,
): void {
  const legacy = path.join(
    root,
    sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session',
  );
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(legacy, 'wire.jsonl'), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG')
      return;
    throw error;
  }
  const lines = raw.split('\n').filter((line) => line.trim());
  const owned =
    lines.length > 0 &&
    lines.every((line) => {
      try {
        const record = JSON.parse(line) as { sessionId?: unknown } | null;
        return record?.sessionId === sessionId;
      } catch {
        return false;
      }
    });
  if (!owned) return;
  try {
    fs.renameSync(legacy, target);
  } catch (error) {
    if (!fs.existsSync(target)) throw error;
  }
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
