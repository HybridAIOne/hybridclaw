/**
 * Mount Security — validates additional mounts against an allowlist stored
 * OUTSIDE the project root, preventing container agents from modifying
 * security configuration.
 *
 * Allowlist location: ~/.config/hybridclaw/mount-allowlist.json
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MOUNT_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
import type { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js';

// Cache the allowlist in memory — only reloads on process restart
let cachedAllowlist: MountAllowlist | null = null;
let allowlistLoadError: string | null = null;

const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
];

/**
 * Load the mount allowlist from the external config location.
 * Returns null if the file doesn't exist or is invalid.
 * Result is cached in memory for the lifetime of the process.
 */
export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) return cachedAllowlist;
  if (allowlistLoadError !== null) return null;

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      allowlistLoadError = `Mount allowlist not found at ${MOUNT_ALLOWLIST_PATH}`;
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found — additional mounts will be BLOCKED. Create the file to enable additional mounts.',
      );
      return null;
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8');
    const allowlist = JSON.parse(content) as MountAllowlist;

    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error('allowedRoots must be an array');
    }
    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array');
    }

    // Merge with default blocked patterns
    allowlist.blockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ];

    cachedAllowlist = allowlist;
    logger.info(
      { path: MOUNT_ALLOWLIST_PATH, allowedRoots: allowlist.allowedRoots.length, blockedPatterns: allowlist.blockedPatterns.length },
      'Mount allowlist loaded',
    );
    return cachedAllowlist;
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err);
    logger.error(
      { path: MOUNT_ALLOWLIST_PATH, error: allowlistLoadError },
      'Failed to load mount allowlist — additional mounts will be BLOCKED',
    );
    return null;
  }
}

function expandPath(p: string): string {
  const homeDir = process.env.HOME || os.homedir();
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2));
  if (p === '~') return homeDir;
  return path.resolve(p);
}

function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function matchesBlockedPattern(realPath: string, blockedPatterns: string[]): string | null {
  const pathParts = realPath.split(path.sep);
  for (const pattern of blockedPatterns) {
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) return pattern;
    }
    if (realPath.includes(pattern)) return pattern;
  }
  return null;
}

function findAllowedRoot(realPath: string, allowedRoots: AllowedRoot[]): AllowedRoot | null {
  for (const root of allowedRoots) {
    const realRoot = getRealPath(expandPath(root.path));
    if (realRoot === null) continue;
    const relative = path.relative(realRoot, realPath);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return root;
  }
  return null;
}

function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes('..')) return false;
  if (containerPath.startsWith('/')) return false;
  if (!containerPath || containerPath.trim() === '') return false;
  return true;
}

export interface MountValidationResult {
  allowed: boolean;
  reason: string;
  realHostPath?: string;
  resolvedContainerPath?: string;
  effectiveReadonly?: boolean;
}

/**
 * Validate a single additional mount against the allowlist.
 */
export function validateMount(mount: AdditionalMount): MountValidationResult {
  const allowlist = loadMountAllowlist();
  if (allowlist === null) {
    return { allowed: false, reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}` };
  }

  const containerPath = mount.containerPath || path.basename(mount.hostPath);
  if (!isValidContainerPath(containerPath)) {
    return { allowed: false, reason: `Invalid container path: "${containerPath}" — must be relative, non-empty, and not contain ".."` };
  }

  const expandedPath = expandPath(mount.hostPath);
  const realPath = getRealPath(expandedPath);
  if (realPath === null) {
    return { allowed: false, reason: `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")` };
  }

  const blockedMatch = matchesBlockedPattern(realPath, allowlist.blockedPatterns);
  if (blockedMatch !== null) {
    return { allowed: false, reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"` };
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason: `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots.map((r) => expandPath(r.path)).join(', ')}`,
    };
  }

  // Determine effective readonly status
  let effectiveReadonly = true;
  if (mount.readonly === false && allowedRoot.allowReadWrite) {
    effectiveReadonly = false;
  } else if (mount.readonly === false && !allowedRoot.allowReadWrite) {
    logger.info({ mount: mount.hostPath, root: allowedRoot.path }, 'Mount forced to read-only — root does not allow read-write');
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''}`,
    realHostPath: realPath,
    resolvedContainerPath: containerPath,
    effectiveReadonly,
  };
}

/**
 * Validate all additional mounts.
 * Returns only mounts that passed validation; logs warnings for rejected ones.
 */
export function validateAdditionalMounts(
  mounts: AdditionalMount[],
): Array<{ hostPath: string; containerPath: string; readonly: boolean }> {
  const validated: Array<{ hostPath: string; containerPath: string; readonly: boolean }> = [];

  for (const mount of mounts) {
    const result = validateMount(mount);
    if (result.allowed) {
      validated.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${result.resolvedContainerPath}`,
        readonly: result.effectiveReadonly!,
      });
      logger.debug({ hostPath: result.realHostPath, containerPath: result.resolvedContainerPath, readonly: result.effectiveReadonly }, 'Mount validated');
    } else {
      logger.warn({ requestedPath: mount.hostPath, containerPath: mount.containerPath, reason: result.reason }, 'Additional mount REJECTED');
    }
  }

  return validated;
}

/**
 * Generate a template allowlist file for users to customize.
 */
export function generateAllowlistTemplate(): string {
  const template: MountAllowlist = {
    allowedRoots: [
      { path: '~/projects', allowReadWrite: true, description: 'Development projects' },
      { path: '~/repos', allowReadWrite: true, description: 'Git repositories' },
      { path: '~/Documents/work', allowReadWrite: false, description: 'Work documents (read-only)' },
    ],
    blockedPatterns: ['password', 'secret', 'token'],
  };
  return JSON.stringify(template, null, 2);
}
