import path from 'node:path';

import { DATA_DIR } from '../../config/config.js';

export const DISCORD_SEND_WORKSPACE_ROOT_DISPLAY = '/workspace';
export const DISCORD_SEND_MEDIA_ROOT_DISPLAY = '/discord-media-cache';
export const DISCORD_SEND_MEDIA_ROOT_HOST_DIR = path.resolve(
  path.join(DATA_DIR, 'discord-media-cache'),
);

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function isWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function resolveDisplayAbsoluteToActual(
  normalizedInput: string,
  displayRoot: string,
  actualRoot: string,
): string | null {
  const normalizedDisplayRoot = path.posix.normalize(displayRoot);
  if (
    normalizedInput !== normalizedDisplayRoot &&
    !normalizedInput.startsWith(`${normalizedDisplayRoot}/`)
  ) {
    return null;
  }

  const relative = normalizedInput
    .slice(normalizedDisplayRoot.length)
    .replace(/^\/+/, '');
  return relative
    ? path.resolve(actualRoot, relative)
    : path.resolve(actualRoot);
}

export function resolveDiscordLocalFileForSend(params: {
  filePath: string;
  sessionWorkspaceRoot?: string | null;
  mediaCacheRoot: string;
}): string | null {
  const input = String(params.filePath || '').trim();
  if (!input) return null;

  const normalizedInput = normalizeSlashes(input);
  const workspaceRoot = params.sessionWorkspaceRoot
    ? path.resolve(params.sessionWorkspaceRoot)
    : null;
  const mediaCacheRoot = path.resolve(params.mediaCacheRoot);

  if (path.posix.isAbsolute(normalizedInput)) {
    const normalizedAbsolute = path.posix.normalize(normalizedInput);

    if (workspaceRoot) {
      const fromWorkspaceDisplay = resolveDisplayAbsoluteToActual(
        normalizedAbsolute,
        DISCORD_SEND_WORKSPACE_ROOT_DISPLAY,
        workspaceRoot,
      );
      if (
        fromWorkspaceDisplay &&
        isWithinRoot(fromWorkspaceDisplay, workspaceRoot)
      ) {
        return fromWorkspaceDisplay;
      }
    }

    const fromMediaDisplay = resolveDisplayAbsoluteToActual(
      normalizedAbsolute,
      DISCORD_SEND_MEDIA_ROOT_DISPLAY,
      mediaCacheRoot,
    );
    if (fromMediaDisplay && isWithinRoot(fromMediaDisplay, mediaCacheRoot)) {
      return fromMediaDisplay;
    }

    const resolvedAbsolute = path.resolve(input);
    if (workspaceRoot && isWithinRoot(resolvedAbsolute, workspaceRoot)) {
      return resolvedAbsolute;
    }
    if (isWithinRoot(resolvedAbsolute, mediaCacheRoot)) {
      return resolvedAbsolute;
    }
    return null;
  }

  if (!workspaceRoot) return null;

  const clean = path.posix.normalize(normalizedInput);
  if (clean === '..' || clean.startsWith('../')) return null;

  const resolved = path.resolve(workspaceRoot, clean);
  return isWithinRoot(resolved, workspaceRoot) ? resolved : null;
}
