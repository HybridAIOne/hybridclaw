import fs from 'node:fs';
import path from 'node:path';

import type { ArtifactMetadata } from './types.js';

export const ARTIFACT_MIME_TYPES: Record<string, string> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.dot': 'text/vnd.graphviz',
  '.excalidraw': 'application/vnd.excalidraw+json',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.mmd': 'text/vnd.mermaid',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.puml': 'text/vnd.plantuml',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

// Package and tool caches never hold a file meant for the user, and on a busy
// workspace they are most of its directories. Virtualenvs (`.venv*`) too.
const ARTIFACT_DISCOVERY_IGNORED_DIRS = new Set([
  '.cache',
  '.git',
  '.hybridclaw',
  '.npm',
  // Sample slides of `show_slide_samples`: shown in their own card.
  '.slide-samples',
  '.synced-skills',
  '__pycache__',
  'node_modules',
]);
const ARTIFACT_DISCOVERY_IGNORED_ROOT_DIRS = new Set(['skills']);

function isIgnoredArtifactDir(name: string): boolean {
  return ARTIFACT_DISCOVERY_IGNORED_DIRS.has(name) || name.startsWith('.venv');
}

export function inferArtifactMimeType(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (normalized.toLowerCase().endsWith('.excalidraw.json')) {
    return 'application/vnd.excalidraw+json';
  }
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
    /** Only files whose name appears in one of these texts. */
    mentionedIn?: readonly string[];
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
        if (isIgnoredArtifactDir(entry.name)) continue;
        if (
          currentDir === resolvedRoot &&
          ARTIFACT_DISCOVERY_IGNORED_ROOT_DIRS.has(entry.name)
        ) {
          continue;
        }
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        options?.mentionedIn &&
        !options.mentionedIn.some((text) => text.includes(entry.name))
      ) {
        continue;
      }

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
