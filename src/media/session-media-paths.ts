/**
 * Maps a sandbox-visible media path (`/workspace/...`, `/discord-media-cache/...`,
 * `/uploaded-media-cache/...`, configured bind mounts) to the host file the
 * gateway may read. Resolution goes through the validated allowed-roots check
 * in `security/media-paths.ts`, so a path outside those roots yields `null`.
 *
 * NOT a write path resolver: callers that write into a workspace resolve
 * relative to the agent workspace directory themselves.
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

export const WORKSPACE_ROOT_DISPLAY = '/workspace';
export const DISCORD_MEDIA_CACHE_ROOT_DISPLAY = '/discord-media-cache';

export function resolveSessionMediaHostPath(
  rawPath: string,
  workspaceRoot: string,
): Promise<string | null> {
  return resolveAllowedHostMediaPath({
    rawPath,
    workspaceRoot,
    workspaceRootDisplay: WORKSPACE_ROOT_DISPLAY,
    mediaCacheRoot: path.resolve(path.join(DATA_DIR, 'discord-media-cache')),
    mediaCacheRootDisplay: DISCORD_MEDIA_CACHE_ROOT_DISPLAY,
    uploadedMediaRoot: resolveUploadedMediaCacheHostDir(),
    uploadedMediaRootDisplay: UPLOADED_MEDIA_CACHE_ROOT_DISPLAY,
    mountAliases: buildValidatedMountAliases({ binds: CONTAINER_BINDS }),
    managedTempDirPrefixes: MANAGED_TEMP_MEDIA_DIR_PREFIXES,
    allowHostAbsolutePaths: CONTAINER_SANDBOX_MODE === 'host',
  });
}
