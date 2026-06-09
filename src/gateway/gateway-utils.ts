import fs from 'node:fs';
import path from 'node:path';
import type { StructuredAuditEntry } from '../types/audit.js';
import { parseJsonObject } from '../utils/json-object.js';
import { finiteNumberOrNull } from '../utils/number-normalization.js';

const COMMON_EXTENSION_MIME_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
};

export function extensionToMimeType(
  extension: string,
  fallback = 'application/octet-stream',
): string {
  const normalized = extension.startsWith('.')
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;
  return COMMON_EXTENSION_MIME_TYPES[normalized] ?? fallback;
}

export function numberFromUnknown(value: unknown): number | null {
  return finiteNumberOrNull(value);
}

export function firstNumber(values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberFromUnknown(value);
    if (parsed != null) return parsed;
  }
  return null;
}

export function parseAuditPayload(
  entry: StructuredAuditEntry,
): Record<string, unknown> | null {
  return parseJsonObject(entry.payload);
}

export function resolveWorkspaceRelativePath(
  workspaceDir: string,
  relativePath: string,
  options?: { requireExistingFile?: boolean },
): string | null {
  const normalized = relativePath.trim();
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.includes('\\') ||
    normalized.split('/').some((segment) => segment === '..' || !segment)
  ) {
    return null;
  }

  const workspacePath = path.resolve(workspaceDir);
  const filePath = path.resolve(workspacePath, normalized);
  const relative = path.relative(workspacePath, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  if (options?.requireExistingFile === false) {
    return filePath;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return null;
  }
  return stats.isFile() ? filePath : null;
}
