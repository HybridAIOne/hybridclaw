import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '../logger.js';
import { resolveConfiguredAdditionalMounts } from './mount-config.js';
import { validateAdditionalMounts } from './mount-security.js';

export interface ValidatedMountAlias {
  hostPath: string;
  containerPath: string;
}

function normalizePathSlashes(value: string): string {
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

async function resolveCanonicalPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function expandPathInput(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

async function isManagedTempMediaPath(
  candidate: string,
  managedTempDirPrefixes: readonly string[],
): Promise<boolean> {
  const resolvedCandidate = path.resolve(candidate);
  const tempRoot = await resolveCanonicalPath(os.tmpdir());
  if (!isWithinRoot(resolvedCandidate, tempRoot)) {
    return false;
  }

  const dirName = path.basename(path.dirname(resolvedCandidate));
  return managedTempDirPrefixes.some((prefix) => dirName.startsWith(prefix));
}

function resolveUnderPrefix(
  normalizedPath: string,
  prefix: string,
  root: string,
): string | null {
  if (normalizedPath !== prefix && !normalizedPath.startsWith(`${prefix}/`)) {
    return null;
  }

  const relative = normalizedPath.slice(prefix.length).replace(/^\/+/, '');
  return relative ? path.resolve(root, relative) : path.resolve(root);
}

function resolveDisplayPathToHost(params: {
  rawPath: string;
  workspaceRoot: string;
  workspaceRootDisplay: string;
  mediaCacheRoot: string;
  mediaCacheRootDisplay: string;
  uploadedMediaRoot: string;
  uploadedMediaRootDisplay: string;
  mountAliases: ValidatedMountAlias[];
}): string | null {
  const {
    rawPath,
    workspaceRoot,
    workspaceRootDisplay,
    mediaCacheRoot,
    mediaCacheRootDisplay,
    uploadedMediaRoot,
    uploadedMediaRootDisplay,
    mountAliases,
  } = params;
  const normalized = normalizePathSlashes(rawPath);

  for (const alias of mountAliases) {
    const resolved = resolveUnderPrefix(
      normalized,
      alias.containerPath,
      alias.hostPath,
    );
    if (resolved) return resolved;
  }

  const workspaceResolved = resolveUnderPrefix(
    normalized,
    workspaceRootDisplay,
    workspaceRoot,
  );
  if (workspaceResolved) return workspaceResolved;

  const mediaResolved = resolveUnderPrefix(
    normalized,
    mediaCacheRootDisplay,
    mediaCacheRoot,
  );
  if (mediaResolved) return mediaResolved;

  return resolveUnderPrefix(
    normalized,
    uploadedMediaRootDisplay,
    uploadedMediaRoot,
  );
}

export function buildValidatedMountAliases(params: {
  binds: string[];
  additionalMounts: string;
}): ValidatedMountAlias[] {
  try {
    const configured = resolveConfiguredAdditionalMounts({
      binds: params.binds,
      additionalMounts: params.additionalMounts,
    });
    if (configured.mounts.length === 0) return [];

    return validateAdditionalMounts(configured.mounts).map((mount) => ({
      hostPath: mount.hostPath,
      containerPath: normalizePathSlashes(mount.containerPath),
    }));
  } catch (error) {
    logger.warn(
      { error },
      'Falling back to built-in media roots after mount alias validation failed',
    );
    return [];
  }
}

export async function resolveAllowedHostMediaPath(params: {
  rawPath: string;
  workspaceRoot: string;
  workspaceRootDisplay: string;
  mediaCacheRoot: string;
  mediaCacheRootDisplay: string;
  uploadedMediaRoot: string;
  uploadedMediaRootDisplay: string;
  mountAliases: ValidatedMountAlias[];
  managedTempDirPrefixes: readonly string[];
  allowHostAbsolutePaths: boolean;
}): Promise<string | null> {
  const cleaned = params.rawPath.trim();
  if (!cleaned) return null;

  const explicitAbsoluteInput =
    path.isAbsolute(cleaned) ||
    /^[A-Za-z]:[\\/]/.test(cleaned) ||
    cleaned.startsWith('~/') ||
    cleaned.startsWith('~\\');

  const displayResolved = resolveDisplayPathToHost({
    rawPath: cleaned,
    workspaceRoot: params.workspaceRoot,
    workspaceRootDisplay: params.workspaceRootDisplay,
    mediaCacheRoot: params.mediaCacheRoot,
    mediaCacheRootDisplay: params.mediaCacheRootDisplay,
    uploadedMediaRoot: params.uploadedMediaRoot,
    uploadedMediaRootDisplay: params.uploadedMediaRootDisplay,
    mountAliases: params.mountAliases,
  });
  const expanded = expandPathInput(cleaned);
  const resolved = displayResolved
    ? displayResolved
    : path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)
      ? path.resolve(expanded)
      : path.resolve(params.workspaceRoot, expanded);
  const canonical = await resolveCanonicalPath(resolved);
  const allowedRoots = await Promise.all(
    [
      params.workspaceRoot,
      params.mediaCacheRoot,
      params.uploadedMediaRoot,
      ...params.mountAliases.map((alias) => alias.hostPath),
    ].map((entry) => resolveCanonicalPath(entry)),
  );

  if (!allowedRoots.some((root) => isWithinRoot(canonical, root))) {
    if (
      !(await isManagedTempMediaPath(
        canonical,
        params.managedTempDirPrefixes,
      )) &&
      !(params.allowHostAbsolutePaths && explicitAbsoluteInput)
    ) {
      return null;
    }
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(canonical);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return canonical;
}
