import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as config from '../config/config.js';
import { logger } from '../logger.js';
import { normalizeMimeType } from './mime-utils.js';

export const UPLOADED_MEDIA_CACHE_ROOT_DISPLAY = '/uploaded-media-cache';

const UPLOADED_MEDIA_CACHE_DIR_MODE = 0o700;
const UPLOADED_MEDIA_CACHE_FILE_MODE = 0o644;
const UPLOADED_MEDIA_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const UPLOADED_MEDIA_CACHE_CLEANUP_MIN_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_SANITIZED_FILENAME_CHARS = 80;
const INVALID_FILENAME_CHARS_RE = /[^\p{L}\p{N}._-]+/gu;
const TRIM_FILENAME_PUNCTUATION_RE = /^[-_.]+|[-_.]+$/g;

const MIME_EXTENSION_MAP: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/xml': '.xml',
};

let cleanupPromise: Promise<void> | null = null;
let lastCleanupStartedAt = 0;

function getUploadedMediaCacheDir(): string | null {
  const dataDir =
    typeof config.DATA_DIR === 'string' ? config.DATA_DIR.trim() : '';
  if (!dataDir) return null;
  return path.resolve(path.join(dataDir, 'uploaded-media-cache'));
}

export function resolveUploadedMediaCacheHostDir(): string {
  const cacheDir = getUploadedMediaCacheDir();
  if (!cacheDir) {
    throw new Error('uploaded_media_cache_dir_unavailable');
  }
  return cacheDir;
}

function normalizeUploadedMediaPathForContainer(
  hostPath: string,
): string | null {
  const cacheDir = getUploadedMediaCacheDir();
  if (!cacheDir) return null;
  const relative = path.relative(cacheDir, hostPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return `${UPLOADED_MEDIA_CACHE_ROOT_DISPLAY}/${relative.replace(/\\/g, '/')}`;
}

export function normalizeUploadedMediaPathForRuntime(
  hostPath: string,
): string | null {
  if (config.CONTAINER_SANDBOX_MODE === 'host') {
    return hostPath;
  }
  return normalizeUploadedMediaPathForContainer(hostPath);
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

export function sanitizeUploadedMediaFilename(
  name: string,
  mimeType?: string | null,
): string {
  const baseName = path.basename(name.normalize('NFKC').trim() || 'upload');
  const parsed = path.parse(baseName);
  const preferredExtension =
    MIME_EXTENSION_MAP[normalizeMimeType(mimeType) || ''];
  const extensionCore = sanitizeFilenameSegment(
    (parsed.ext || preferredExtension || '').replace(/^\.+/, '').toLowerCase(),
  );
  const extension = extensionCore ? `.${extensionCore}` : '';
  const maxBaseChars = Math.max(
    1,
    MAX_SANITIZED_FILENAME_CHARS - extension.length,
  );
  const fallbackBase = 'upload'.slice(0, maxBaseChars);
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
      'Best-effort uploaded media permission update failed',
    );
  }
}

async function ensureCacheDirectory(dirPath: string): Promise<void> {
  await fs.promises.mkdir(dirPath, {
    mode: UPLOADED_MEDIA_CACHE_DIR_MODE,
    recursive: true,
  });
  await enforcePathMode(dirPath, UPLOADED_MEDIA_CACHE_DIR_MODE);
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

export async function cleanupUploadedMediaCache(params?: {
  nowMs?: number;
  rootDir?: string;
  ttlMs?: number;
}): Promise<void> {
  const rootDir = params?.rootDir
    ? path.resolve(params.rootDir)
    : getUploadedMediaCacheDir();
  if (!rootDir) return;
  const ttlMs =
    typeof params?.ttlMs === 'number' && Number.isFinite(params.ttlMs)
      ? Math.max(1, Math.floor(params.ttlMs))
      : UPLOADED_MEDIA_CACHE_TTL_MS;

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
      'Uploaded media cache cleanup completed',
    );
  }
}

export function startUploadedMediaCacheCleanup(params?: {
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
    now - lastCleanupStartedAt < UPLOADED_MEDIA_CACHE_CLEANUP_MIN_INTERVAL_MS
  ) {
    return null;
  }

  lastCleanupStartedAt = now;
  cleanupPromise = cleanupUploadedMediaCache(params)
    .catch((error) => {
      logger.warn(
        {
          cacheDir: params?.rootDir ?? getUploadedMediaCacheDir(),
          error,
        },
        'Uploaded media cache cleanup failed',
      );
    })
    .finally(() => {
      cleanupPromise = null;
    });
  return cleanupPromise;
}

export async function writeUploadedMediaCacheFile(params: {
  attachmentName: string;
  buffer: Buffer;
  mimeType?: string | null;
}): Promise<{ hostPath: string; runtimePath: string; filename: string }> {
  const cacheDir = resolveUploadedMediaCacheHostDir();
  const datePrefix = new Date().toISOString().slice(0, 10);
  const unique = randomUUID().slice(0, 8);
  const filename = sanitizeUploadedMediaFilename(
    params.attachmentName,
    params.mimeType,
  );
  const fileName = `${Date.now()}-${unique}-${filename}`;
  const dayDir = path.join(cacheDir, datePrefix);
  const hostPath = path.join(dayDir, fileName);

  await ensureCacheDirectory(cacheDir);
  await ensureCacheDirectory(dayDir);
  await fs.promises.writeFile(hostPath, params.buffer, {
    mode: UPLOADED_MEDIA_CACHE_FILE_MODE,
  });
  await enforcePathMode(hostPath, UPLOADED_MEDIA_CACHE_FILE_MODE);

  const runtimePath = normalizeUploadedMediaPathForRuntime(hostPath);
  if (!runtimePath) {
    throw new Error(`uploaded_media_cache_path_error:${hostPath}`);
  }

  startUploadedMediaCacheCleanup();
  return {
    hostPath,
    runtimePath,
    filename,
  };
}
