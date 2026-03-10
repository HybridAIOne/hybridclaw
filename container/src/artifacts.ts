import fs from 'node:fs';
import path from 'node:path';

import type { ArtifactMetadata } from './types.js';

export const ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ARTIFACT_DISCOVERY_IGNORED_DIRS = new Set([
  '.git',
  '.hybridclaw',
  '.synced-skills',
  'node_modules',
]);

export function inferArtifactMimeType(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const ext = path.posix.extname(normalized).toLowerCase();
  return ARTIFACT_MIME_TYPES[ext] || 'application/octet-stream';
}

export function discoverArtifactsSince(
  rootPath: string,
  options?: {
    modifiedAfterMs?: number;
    modifiedBeforeMs?: number;
    excludePaths?: Iterable<string>;
    limit?: number;
  },
): ArtifactMetadata[] {
  const resolvedRoot = path.resolve(rootPath);
  const modifiedAfterMs = options?.modifiedAfterMs ?? 0;
  const modifiedBeforeMs =
    options?.modifiedBeforeMs ?? Number.POSITIVE_INFINITY;
  const limit = Math.max(1, Math.min(20, options?.limit ?? 8));
  const excluded = new Set(
    Array.from(options?.excludePaths || [], (entry) => path.resolve(entry)),
  );
  const found: Array<ArtifactMetadata & { mtimeMs: number }> = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (excluded.has(absolutePath)) continue;

      if (entry.isDirectory()) {
        if (ARTIFACT_DISCOVERY_IGNORED_DIRS.has(entry.name)) continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const mimeType = inferArtifactMimeType(absolutePath);
      if (mimeType === 'application/octet-stream') continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }

      if (
        stat.size <= 0 ||
        stat.mtimeMs < modifiedAfterMs ||
        stat.mtimeMs > modifiedBeforeMs
      ) {
        continue;
      }

      found.push({
        path: absolutePath,
        filename: path.basename(absolutePath),
        mimeType,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  walk(resolvedRoot);

  found.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      left.filename.localeCompare(right.filename),
  );

  return found
    .slice(0, limit)
    .map(({ mtimeMs: _mtimeMs, ...artifact }) => artifact);
}
