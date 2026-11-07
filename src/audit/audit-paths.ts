/**
 * Audit paths isolate exact session identities and preserve owned legacy logs.
 * Unlike audit-trail, this module neither appends nor verifies hash chains.
 * Ambiguous legacy logs remain untouched and require explicit operator recovery.
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
  if (fs.existsSync(target)) return target;

  // compat: remove after v0.43. A successful rename removes the migration source.
  const legacy = path.join(
    root,
    sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session',
  );
  const wirePath = path.join(legacy, 'wire.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(wirePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENAMETOOLONG') return target;
    throw error;
  }
  const lines = raw.split('\n').filter((line) => line.trim());
  let records: { sessionId?: unknown }[];
  try {
    records = lines.map((line) => JSON.parse(line) as { sessionId?: unknown });
  } catch {
    throw new Error(
      `Legacy audit log is malformed; recover it before continuing: ${wirePath}`,
    );
  }
  if (
    !records.length ||
    records.some((record) => !record || typeof record.sessionId !== 'string')
  ) {
    throw new Error(
      `Legacy audit log has no reliable session identity: ${wirePath}`,
    );
  }
  const owner = records[0].sessionId;
  if (records.some((record) => record.sessionId !== owner)) {
    throw new Error(
      `Legacy audit log contains multiple sessions; recover it before continuing: ${wirePath}`,
    );
  }
  if (owner !== sessionId) return target;
  try {
    fs.renameSync(legacy, target);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
      !fs.existsSync(target)
    )
      throw error;
  }
  return target;
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
