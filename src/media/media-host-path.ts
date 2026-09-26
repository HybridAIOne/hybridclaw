/**
 * Agent-visible media path → existing host file, for gateway-side reads.
 *
 * Maps the display roots the agent sees (`/workspace`, `/discord-media-cache`,
 * `/uploaded-media-cache`), validated extra mounts, managed channel temp dirs
 * and, in host sandbox mode, host-absolute paths back to a regular file under
 * an allowed root. Anything outside those roots, or a file media cleanup has
 * already removed, resolves to null.
 *
 * NOT the container-side resolver (`container/src/runtime-paths.ts`), which
 * enforces the same roots for tool calls inside the sandbox.
 */
import path from 'node:path';

import {
  CONTAINER_BINDS,
  CONTAINER_SANDBOX_MODE,
  DATA_DIR,
} from '../config/config.js';
import {
  buildValidatedMountAliases,
  resolveAllowedHostMediaPath,
} from '../security/media-paths.js';
import { MANAGED_TEMP_MEDIA_DIR_PREFIXES } from './managed-temp-media.js';
import {
  resolveUploadedMediaCacheHostDir,
  UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
} from './uploaded-media-cache.js';

const WORKSPACE_ROOT_DISPLAY = '/workspace';
const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';
const DISCORD_MEDIA_CACHE_ROOT = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);

/** Mount aliases are validated once per resolver, not once per path. */
export function createMediaHostPathResolver(
  workspaceRoot: string,
): (rawPath: string) => Promise<string | null> {
  const mountAliases = buildValidatedMountAliases({ binds: CONTAINER_BINDS });
  const uploadedMediaRoot = resolveUploadedMediaCacheHostDir();
  return (rawPath) =>
    resolveAllowedHostMediaPath({
      rawPath,
      workspaceRoot,
      workspaceRootDisplay: WORKSPACE_ROOT_DISPLAY,
      mediaCacheRoot: DISCORD_MEDIA_CACHE_ROOT,
      mediaCacheRootDisplay: DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
      uploadedMediaRoot,
      uploadedMediaRootDisplay: UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
      mountAliases,
      managedTempDirPrefixes: MANAGED_TEMP_MEDIA_DIR_PREFIXES,
      allowHostAbsolutePaths: CONTAINER_SANDBOX_MODE === 'host',
    });
}
