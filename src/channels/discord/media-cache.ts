import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as config from '../../config/config.js';
import { logger } from '../../logger.js';

const CONTAINER_DISCORD_MEDIA_CACHE_DIR = '/discord-media-cache';
const DISCORD_MEDIA_CACHE_DIR_MODE = 0o700;
const DISCORD_MEDIA_CACHE_FILE_MODE = 0o644;
const DISCORD_MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DISCORD_MEDIA_CACHE_CLEANUP_MIN_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_SANITIZED_FILENAME_CHARS = 60;
const INVALID_FILENAME_CHARS_RE = /[^\p{L}\p{N}._-]+/gu;
const TRIM_FILENAME_PUNCTUATION_RE = /^[-_.]+|[-_.]+$/g;

let cleanupPromise: Promise<void> | null = null;
let lastCleanupStartedAt = 0;

function getDiscordMediaCacheDir(): string | null {
  const dataDir =
    typeof config.DATA_DIR === 'string' ? config.DATA_DIR.trim() : '';
  if (!dataDir) return null;
  return path.resolve(path.join(dataDir, 'discord-media-cache'));
}

function normalizeAttachmentPathForContainer(hostPath: string): string | null {
  const cacheDir = getDiscordMediaCacheDir();
  if (!cacheDir) return null;
  const relative = path.relative(cacheDir, hostPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    return null;
  return `${CONTAINER_DISCORD_MEDIA_CACHE_DIR}/${relative.replace(/\\/g, '/')}`;
}

export function normalizeAttachmentPathForRuntime(
  hostPath: string,
): string | null {
  if (config.CONTAINER_SANDBOX_MODE === 'host') {
    return hostPath;
  }
  return normalizeAttachmentPathForContainer(hostPath);
}

function sanitizeFilenameSegment(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(INVALID_FILENAME_CHARS_RE, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(TRIM_FILENAME_PUNCTUATION_RE, '');
}

export function sanitizeAttachmentFilename(name: string): string {
  const normalized = name.normalize('NFKC').trim();
  const parsed = path.parse(normalized);
  const extensionCore = sanitizeFilenameSegment(
    parsed.ext.replace(/^\.+/, '').toLowerCase(),
  );
  const extension = extensionCore ? `.${extensionCore}` : '';
  const maxBaseChars = Math.max(
    1,
    MAX_SANITIZED_FILENAME_CHARS - extension.length,
  );
  const fallbackBase = 'attachment'.slice(0, maxBaseChars);
  const base =
    sanitizeFilenameSegment(parsed.name).slice(0, maxBaseChars) || fallbackBase;
  return `${base}${extension}`;
}

async function enforcePathMode(filePath: string, mode: number): Promise<void> {
  try {
    await fs.promises.chmod(filePath, mode);
  } catch (error) {
    logger.debug(
      {
        error,
        filePath,
        mode: mode.toString(8),
      },
      'Best-effort cache permission update failed',
    );
  }
}

async function ensureCacheDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, {
    mode: DISCORD_MEDIA_CACHE_DIR_MODE,
    recursive: true,
  });
  await enforcePathMode(dirPath, DISCORD_MEDIA_CACHE_DIR_MODE);
}

async function pruneExpiredEntries(
  rootDir: string,
  currentDir: string,
  expiresBeforeMs: number,
  stats: { prunedDirs: number; removedFiles: number },
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    if (stat.isSymbolicLink()) {
      try {
        await fs.promises.unlink(entryPath);
        stats.removedFiles += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }

    if (stat.isDirectory()) {
      await pruneExpiredEntries(rootDir, entryPath, expiresBeforeMs, stats);
      continue;
    }

    if (stat.mtimeMs >= expiresBeforeMs) continue;

    try {
      await fs.promises.rm(entryPath, { force: true, recursive: false });
      stats.removedFiles += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  if (currentDir === rootDir) return;

  try {
    const remainingEntries = await fs.promises.readdir(currentDir);
    if (remainingEntries.length > 0) return;
    await fs.promises.rmdir(currentDir);
    stats.prunedDirs += 1;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
  }
}

export async function cleanupDiscordMediaCache(params?: {
  nowMs?: number;
  rootDir?: string;
  ttlMs?: number;
}): Promise<void> {
  const rootDir = params?.rootDir
    ? path.resolve(params.rootDir)
    : getDiscordMediaCacheDir();
  if (!rootDir) return;
  const ttlMs =
    typeof params?.ttlMs === 'number' && Number.isFinite(params.ttlMs)
      ? Math.max(1, Math.floor(params.ttlMs))
      : DISCORD_MEDIA_CACHE_TTL_MS;

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(rootDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory()) return;

  const expiresBeforeMs = (params?.nowMs ?? Date.now()) - ttlMs;
  const stats = { prunedDirs: 0, removedFiles: 0 };
  await pruneExpiredEntries(rootDir, rootDir, expiresBeforeMs, stats);
  if (stats.removedFiles > 0 || stats.prunedDirs > 0) {
    logger.debug(
      {
        cacheDir: rootDir,
        prunedDirs: stats.prunedDirs,
        removedFiles: stats.removedFiles,
      },
      'Discord media cache cleanup completed',
    );
  }
}

function startDiscordMediaCacheCleanup(params?: {
  force?: boolean;
  nowMs?: number;
  rootDir?: string;
  ttlMs?: number;
}): Promise<void> | null {
  const now = params?.nowMs ?? Date.now();
  if (cleanupPromise) {
    return cleanupPromise;
  }
  if (
    !params?.force &&
    lastCleanupStartedAt > 0 &&
    now - lastCleanupStartedAt < DISCORD_MEDIA_CACHE_CLEANUP_MIN_INTERVAL_MS
  ) {
    return null;
  }

  lastCleanupStartedAt = now;
  cleanupPromise = cleanupDiscordMediaCache(params)
    .catch((error) => {
      logger.warn(
        {
          cacheDir: params?.rootDir ?? getDiscordMediaCacheDir(),
          error,
        },
        'Discord media cache cleanup failed',
      );
    })
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
}

export function triggerDiscordMediaCacheCleanup(params?: {
  force?: boolean;
  nowMs?: number;
  rootDir?: string;
  ttlMs?: number;
}): Promise<void> | null {
  return startDiscordMediaCacheCleanup(params);
}

export async function writeDiscordMediaCacheFile(params: {
  attachmentName: string;
  buffer: Buffer;
  messageId: string;
  order: number;
}): Promise<{ hostPath: string; runtimePath: string }> {
  const cacheDir = getDiscordMediaCacheDir();
  if (!cacheDir) {
    throw new Error('discord_media_cache_dir_unavailable');
  }
  const datePrefix = new Date().toISOString().slice(0, 10);
  const unique = randomUUID().slice(0, 8);
  const fileName = `${Date.now()}-${params.messageId}-${String(params.order).padStart(3, '0')}-${unique}-${sanitizeAttachmentFilename(params.attachmentName)}`;
  const dayDir = path.join(cacheDir, datePrefix);
  const hostPath = path.join(dayDir, fileName);

  await ensureCacheDirectory(cacheDir);
  await ensureCacheDirectory(dayDir);
  await fs.promises.writeFile(hostPath, params.buffer, {
    mode: DISCORD_MEDIA_CACHE_FILE_MODE,
  });
  await enforcePathMode(hostPath, DISCORD_MEDIA_CACHE_FILE_MODE);

  const runtimePath = normalizeAttachmentPathForRuntime(hostPath);
  if (!runtimePath) {
    throw new Error(`cache_path_error:${hostPath}`);
  }

  return { hostPath, runtimePath };
}
