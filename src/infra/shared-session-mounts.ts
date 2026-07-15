import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { MediaContextItem } from '../types/container.js';

const CONTAINER_DISCORD_MEDIA_CACHE_ROOT = '/discord-media-cache';
const CONTAINER_UPLOADED_MEDIA_CACHE_ROOT = '/uploaded-media-cache';

export interface SharedSessionMounts {
  browserProfileHostPath: string;
  behaviorAnomalyTrajectoryStoreDir: string;
  discordMediaCacheHostPath: string;
  uploadedMediaCacheHostPath: string;
  media: MediaContextItem[] | undefined;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

function ensurePrivateDirectory(dir: string): void {
  if (fs.existsSync(dir)) {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Shared-user mount path is not a directory: ${dir}`);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(dir, 0o700);
}

function resetPrivateDirectory(dir: string): void {
  ensurePrivateDirectory(dir);
  // Preserve the root inode because a persistent container may already mount it.
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function resolveProtectedMediaSource(params: {
  rawPath: string;
  hostRoot: string;
  containerRoot: string;
}): { relativePath: string; sourcePath: string } | null {
  const hostRoot = path.resolve(params.hostRoot);
  let relativePath: string;
  if (params.rawPath.startsWith(`${params.containerRoot}/`)) {
    relativePath = params.rawPath.slice(params.containerRoot.length + 1);
  } else if (path.isAbsolute(params.rawPath)) {
    relativePath = path.relative(hostRoot, path.resolve(params.rawPath));
  } else {
    return null;
  }

  const sourceCandidate = path.resolve(hostRoot, relativePath);
  if (!isPathWithin(hostRoot, sourceCandidate)) return null;

  let realHostRoot: string;
  let realSourcePath: string;
  try {
    realHostRoot = fs.realpathSync(hostRoot);
    realSourcePath = fs.realpathSync(sourceCandidate);
  } catch {
    return null;
  }
  if (!isPathWithin(realHostRoot, realSourcePath)) return null;
  if (!fs.statSync(realSourcePath).isFile()) return null;

  return {
    relativePath: path.relative(hostRoot, sourceCandidate),
    sourcePath: realSourcePath,
  };
}

function stageProtectedMediaItem(params: {
  item: MediaContextItem;
  hostRoot: string;
  stageRoot: string;
  containerRoot: string;
}): MediaContextItem {
  const rawPath = params.item.path?.trim();
  if (!rawPath) return params.item;

  const hostRoot = path.resolve(params.hostRoot);
  const targetsProtectedRoot =
    rawPath === params.containerRoot ||
    rawPath.startsWith(`${params.containerRoot}/`) ||
    (path.isAbsolute(rawPath) &&
      (path.resolve(rawPath) === hostRoot ||
        isPathWithin(hostRoot, path.resolve(rawPath))));
  if (!targetsProtectedRoot) return params.item;

  const source = resolveProtectedMediaSource({
    rawPath,
    hostRoot,
    containerRoot: params.containerRoot,
  });
  if (!source) return { ...params.item, path: null };

  const destination = path.resolve(params.stageRoot, source.relativePath);
  if (!isPathWithin(params.stageRoot, destination)) {
    return { ...params.item, path: null };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(destination)) {
    fs.copyFileSync(source.sourcePath, destination);
    fs.chmodSync(destination, 0o600);
  }

  const containerRelativePath = source.relativePath.split(path.sep).join('/');
  return {
    ...params.item,
    path: `${params.containerRoot}/${containerRelativePath}`,
  };
}

export function prepareSharedSessionMounts(params: {
  dataDir: string;
  sessionId: string;
  agentId: string;
  media?: MediaContextItem[];
  sourceDiscordRoot: string;
  sourceUploadedRoot: string;
}): SharedSessionMounts {
  const sharedSessionMountsDir = path.join(
    params.dataDir,
    'runtime',
    'shared-session-mounts',
  );
  ensurePrivateDirectory(sharedSessionMountsDir);
  const sessionKey = createHash('sha256')
    .update(params.agentId)
    .update('\0')
    .update(params.sessionId)
    .digest('hex');
  const sessionMountRoot = path.join(sharedSessionMountsDir, sessionKey);
  ensurePrivateDirectory(sessionMountRoot);

  const discordMediaCacheHostPath = path.join(
    sessionMountRoot,
    'discord-media-cache',
  );
  const uploadedMediaCacheHostPath = path.join(
    sessionMountRoot,
    'uploaded-media-cache',
  );
  const browserProfileHostPath = path.join(sessionMountRoot, 'browser-profile');
  const behaviorAnomalyTrajectoryStoreDir = path.join(
    sessionMountRoot,
    'trajectory-mask',
  );
  resetPrivateDirectory(discordMediaCacheHostPath);
  resetPrivateDirectory(uploadedMediaCacheHostPath);
  ensurePrivateDirectory(browserProfileHostPath);
  resetPrivateDirectory(behaviorAnomalyTrajectoryStoreDir);

  fs.mkdirSync(params.sourceDiscordRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(params.sourceUploadedRoot, { recursive: true, mode: 0o700 });

  const media = params.media?.map((item) => {
    const discordItem = stageProtectedMediaItem({
      item,
      hostRoot: params.sourceDiscordRoot,
      stageRoot: discordMediaCacheHostPath,
      containerRoot: CONTAINER_DISCORD_MEDIA_CACHE_ROOT,
    });
    return stageProtectedMediaItem({
      item: discordItem,
      hostRoot: params.sourceUploadedRoot,
      stageRoot: uploadedMediaCacheHostPath,
      containerRoot: CONTAINER_UPLOADED_MEDIA_CACHE_ROOT,
    });
  });

  return {
    browserProfileHostPath,
    behaviorAnomalyTrajectoryStoreDir,
    discordMediaCacheHostPath,
    uploadedMediaCacheHostPath,
    media,
  };
}
