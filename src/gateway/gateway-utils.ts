import fs from 'node:fs';
import path from 'node:path';
import type { StructuredAuditEntry } from '../types/audit.js';

export function numberFromUnknown(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    Number.isNaN(value) ||
    !Number.isFinite(value)
  ) {
    return null;
  }
  return value;
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
  try {
    const parsed = JSON.parse(entry.payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
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
