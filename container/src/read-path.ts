/**
 * Read-tool media paths — resolves only files attached to the current turn.
 *
 * Unlike the general media resolver, this does not expose the whole cache;
 * unlike workspace resolution, it authorizes no writes or directory searches.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveMediaPath,
  UPLOADED_MEDIA_CACHE_ROOT,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type { MediaContextItem } from './types.js';

function canonicalPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    try {
      return fs.realpathSync(filePath);
    } catch {
      return path.resolve(filePath);
    }
  }
}

function resolveCurrentTurnMediaPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  const requestedPath = resolveMediaPath(rawPath);
  if (!requestedPath) return null;
  const requestedCanonical = canonicalPath(requestedPath);

  for (const item of media) {
    const itemPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!itemPath) continue;
    const resolvedItemPath = resolveMediaPath(itemPath);
    if (!resolvedItemPath) continue;
    if (canonicalPath(resolvedItemPath) === requestedCanonical) {
      return requestedCanonical;
    }
  }

  return null;
}

function mapHostRootToDisplay(
  filePath: string,
  actualRoot: string,
  displayRoot: string,
): string | null {
  const relative = path.relative(
    path.resolve(actualRoot),
    path.resolve(filePath),
  );
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative
    ? path.posix.join(displayRoot, relative.replace(/\\/g, '/'))
    : displayRoot;
}

export function resolveCurrentTurnMediaReadPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  return resolveCurrentTurnMediaPath(rawPath, media);
}

export function resolveCurrentTurnMediaSandboxPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  const mediaPath = resolveCurrentTurnMediaPath(rawPath, media);
  if (!mediaPath) return null;
  return (
    mapHostRootToDisplay(
      mediaPath,
      DISCORD_MEDIA_CACHE_ROOT,
      DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
    ) ||
    mapHostRootToDisplay(
      mediaPath,
      UPLOADED_MEDIA_CACHE_ROOT,
      UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
    )
  );
}
