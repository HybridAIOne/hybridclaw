import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';

export const WHATSAPP_MEDIA_TMP_PREFIX = 'hybridclaw-wa-';
export const MANAGED_TEMP_MEDIA_DIR_PREFIXES = [WHATSAPP_MEDIA_TMP_PREFIX];

function resolveManagedTempRoot(rootDir?: string): string {
  return path.resolve(rootDir ?? os.tmpdir());
}

export function resolveManagedTempMediaDir(params: {
  filePath: string;
  rootDir?: string;
  prefixes?: readonly string[];
}): string | null {
  const normalizedPath = String(params.filePath || '').trim();
  if (!normalizedPath) return null;

  const rootDir = resolveManagedTempRoot(params.rootDir);
  const prefixes = params.prefixes ?? MANAGED_TEMP_MEDIA_DIR_PREFIXES;
  const absolutePath = path.resolve(normalizedPath);
  const relativePath = path.relative(rootDir, absolutePath);
  if (
    !relativePath ||
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  const [topLevelEntry] = relativePath.split(path.sep);
  if (
    !topLevelEntry ||
    !prefixes.some((prefix) => topLevelEntry.startsWith(prefix))
  ) {
    return null;
  }

  return path.join(rootDir, topLevelEntry);
}

export function isManagedTempMediaPath(params: {
  filePath: string;
  rootDir?: string;
  prefixes?: readonly string[];
}): boolean {
  return resolveManagedTempMediaDir(params) !== null;
}

export async function cleanupManagedTempMediaDirectories(params?: {
  rootDir?: string;
  prefixes?: readonly string[];
}): Promise<void> {
  const rootDir = resolveManagedTempRoot(params?.rootDir);
  const prefixes = params?.prefixes ?? MANAGED_TEMP_MEDIA_DIR_PREFIXES;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  let removedDirs = 0;
  let removedLinks = 0;
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;

    const entryPath = path.join(rootDir, entry.name);
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    try {
      if (stat.isSymbolicLink()) {
        await fs.unlink(entryPath);
        removedLinks += 1;
        continue;
      }
      if (!stat.isDirectory()) continue;
      await fs.rm(entryPath, { recursive: true, force: true });
      removedDirs += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  if (removedDirs > 0 || removedLinks > 0) {
    logger.debug(
      {
        rootDir,
        prefixes,
        removedDirs,
        removedLinks,
      },
      'Managed temp media cleanup completed',
    );
  }
}
