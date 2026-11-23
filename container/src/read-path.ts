/**
 * Read-tool paths bind workspace, HTTP artifact and session attachment names to one target.
 *
 * Media access is restricted to the files attached to the current session;
 * unlike workspace resolution, it authorizes no writes or directory searches.
 */
import path from 'node:path';

import { resolveHttpArtifactReadPath } from './http-artifact-read-path.js';
import {
  DISCORD_MEDIA_CACHE_ROOT,
  DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
  resolveCanonicalPath,
  resolveFileToolPath,
  resolveMediaPath,
  TASK_SANDBOX_FS_ENABLED,
  UPLOADED_MEDIA_CACHE_ROOT,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
} from './runtime-paths.js';
import type { MediaContextItem } from './types.js';

let sessionMedia: readonly MediaContextItem[] = [];
let sessionMediaPaths = new Set<string>();

// Rebuilt from gateway-owned conversation metadata on every input. Never read
// an agent-writable allowlist from the workspace to authorize cache access.
export function setReadableMediaPaths(
  paths: readonly string[],
  media: readonly MediaContextItem[],
): void {
  sessionMedia = media;
  sessionMediaPaths = new Set(
    paths.flatMap((value) => {
      const resolved = resolveMediaPath(value);
      return resolved ? [resolveCanonicalPath(resolved)] : [];
    }),
  );
}

function resolveSessionMediaPath(rawPath: string): string | null {
  const requestedPath = resolveMediaPath(rawPath);
  if (!requestedPath) return null;
  const requestedCanonical = resolveCanonicalPath(requestedPath);
  if (sessionMediaPaths.has(requestedCanonical)) return requestedCanonical;

  for (const item of sessionMedia) {
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

/** Execution and scheduling use the same authorized target, including read-only aliases. */
export function resolveReadToolPath(rawPath: string): string | null {
  const mediaPath = resolveSessionMediaPath(rawPath);
  if (!TASK_SANDBOX_FS_ENABLED) {
    return (
      mediaPath ||
      resolveHttpArtifactReadPath(rawPath) ||
      resolveFileToolPath(rawPath)
    );
  }
  if (mediaPath) {
    const mounted =
      mapHostRootToDisplay(
        mediaPath,
        DISCORD_MEDIA_CACHE_ROOT,
        DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      ) ||
      mapHostRootToDisplay(
        mediaPath,
        UPLOADED_MEDIA_CACHE_ROOT,
        UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
      );
    if (mounted) return mounted;
  }
  return resolveFileToolPath(rawPath);
}
