/**
 * Read-tool media paths — resolves only files attached to this session.
 *
 * Unlike the general media resolver, this does not expose the whole cache;
 * unlike workspace resolution, it authorizes no writes or directory searches.
 */
import path from 'node:path';

import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveCanonicalPath,
  resolveMediaPath,
  UPLOADED_MEDIA_CACHE_ROOT,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type { MediaContextItem } from './types.js';

let sessionMediaPaths = new Set<string>();

// Rebuilt from gateway-owned conversation metadata on every input. Never read
// an agent-writable allowlist from the workspace to authorize cache access.
export function setReadableMediaPaths(paths: readonly string[]): void {
  sessionMediaPaths = new Set(
    paths.flatMap((value) => {
      const resolved = resolveMediaPath(value);
      return resolved ? [resolveCanonicalPath(resolved)] : [];
    }),
  );
}

function resolveSessionMediaPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  const requestedPath = resolveMediaPath(rawPath);
  if (!requestedPath) return null;
  const requestedCanonical = resolveCanonicalPath(requestedPath);
  if (sessionMediaPaths.has(requestedCanonical)) return requestedCanonical;

  for (const item of media) {
    const itemPath = typeof item.path === 'string' ? item.path.trim() : '';
    if (!itemPath) continue;
    const resolvedItemPath = resolveMediaPath(itemPath);
    if (!resolvedItemPath) continue;
    if (resolveCanonicalPath(resolvedItemPath) === requestedCanonical) {
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

export function resolveSessionMediaReadPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  return resolveSessionMediaPath(rawPath, media);
}

export function resolveSessionMediaSandboxPath(
  rawPath: string,
  media: readonly MediaContextItem[],
): string | null {
  const mediaPath = resolveSessionMediaPath(rawPath, media);
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
