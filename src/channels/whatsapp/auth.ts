import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';
import { sleep } from '../../utils/sleep.js';

export const WHATSAPP_AUTH_DIR = path.join(
  os.homedir(),
  '.hybridclaw',
  'credentials',
  'whatsapp',
);
const WHATSAPP_AUTH_LOCK_TIMEOUT_MS = 2_000;
const WHATSAPP_AUTH_LOCK_CORRUPT_STALE_MS = 10_000;
const WHATSAPP_AUTH_FILE_MODE = 0o600;

interface WhatsAppAuthLockMetadata {
  pid: number | null;
  startedAt: string;
  purpose: string;
  cwd: string;
}

export class WhatsAppAuthLockError extends Error {
  readonly lockPath: string;
  readonly ownerPid: number | null;

  constructor(
    message: string,
    options: { lockPath: string; ownerPid?: number | null },
  ) {
    super(message);
    this.name = 'WhatsAppAuthLockError';
    this.lockPath = options.lockPath;
    this.ownerPid = options.ownerPid ?? null;
  }
}

export function whatsappAuthLockPath(authDir = WHATSAPP_AUTH_DIR): string {
  return `${authDir}.lock`;
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockMetadata(lockPath: string): WhatsAppAuthLockMetadata | null {
  try {
    const raw = fsSync.readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WhatsAppAuthLockMetadata>;
    const pid =
      typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)
        ? Math.trunc(parsed.pid)
        : null;
    return {
      pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : '',
    };
  } catch {
    return null;
  }
}

function maybeClearInactiveAuthLock(lockPath: string): boolean {
  const metadata = readLockMetadata(lockPath);
  if (metadata?.pid != null) {
    if (isProcessRunning(metadata.pid)) return false;
    try {
      fsSync.rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  try {
    const stat = fsSync.statSync(lockPath);
    if (Date.now() - stat.mtimeMs <= WHATSAPP_AUTH_LOCK_CORRUPT_STALE_MS) {
      return false;
    }
    fsSync.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function acquireWhatsAppAuthLock(
  authDir = WHATSAPP_AUTH_DIR,
  options?: {
    purpose?: string;
    timeoutMs?: number;
  },
): Promise<() => void> {
  const lockPath = whatsappAuthLockPath(authDir);
  const timeoutMs = Math.max(
    0,
    options?.timeoutMs ?? WHATSAPP_AUTH_LOCK_TIMEOUT_MS,
  );
  const startedAt = Date.now();
  let backoffMs = 50;

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const fd = fsSync.openSync(lockPath, 'wx', WHATSAPP_AUTH_FILE_MODE);
      const payload: WhatsAppAuthLockMetadata = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        purpose: String(options?.purpose || 'runtime').trim() || 'runtime',
        cwd: process.cwd(),
      };
      fsSync.writeFileSync(
        fd,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf-8',
      );
      fsSync.closeSync(fd);
      return () => {
        try {
          fsSync.rmSync(lockPath, { force: true });
        } catch {
          // best effort
        }
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw new WhatsAppAuthLockError(
          `Failed to acquire WhatsApp auth lock at ${lockPath}.`,
          { lockPath },
        );
      }
      if (maybeClearInactiveAuthLock(lockPath)) continue;
      if (timeoutMs === 0) break;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 250);
    }
  }

  const owner = readLockMetadata(lockPath);
  const ownerHint = owner?.pid != null ? ` (owned by pid ${owner.pid})` : '';
  throw new WhatsAppAuthLockError(
    `WhatsApp auth state is already in use${ownerHint}. Stop the other HybridClaw process before linking or resetting WhatsApp.`,
    {
      lockPath,
      ownerPid: owner?.pid ?? null,
    },
  );
}

export async function ensureWhatsAppAuthDir(
  authDir = WHATSAPP_AUTH_DIR,
): Promise<string> {
  await fs.mkdir(authDir, { recursive: true });
  return authDir;
}

export async function resetWhatsAppAuthState(
  authDir = WHATSAPP_AUTH_DIR,
): Promise<string> {
  const releaseLock = await acquireWhatsAppAuthLock(authDir, {
    purpose: 'reset',
  });
  try {
    await fs.rm(authDir, { recursive: true, force: true });
    await fs.mkdir(authDir, { recursive: true });
    return authDir;
  } finally {
    releaseLock();
  }
}

export async function loadWhatsAppAuthState(authDir = WHATSAPP_AUTH_DIR) {
  const resolvedAuthDir = await ensureWhatsAppAuthDir(authDir);
  return useMultiFileAuthState(resolvedAuthDir);
}

export async function getWhatsAppAuthStatus(
  authDir = WHATSAPP_AUTH_DIR,
): Promise<{
  linked: boolean;
  jid: string | null;
}> {
  const credsPath = path.join(authDir, 'creds.json');
  try {
    const raw = await fs.readFile(credsPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      registered?: unknown;
      me?: { id?: unknown } | null;
    };
    const jid =
      typeof parsed?.me?.id === 'string' && parsed.me.id.trim()
        ? parsed.me.id.trim()
        : null;
    const linked = jid != null || parsed?.registered === true;
    return { linked, jid };
  } catch {
    return { linked: false, jid: null };
  }
}
