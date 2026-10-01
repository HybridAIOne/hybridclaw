/**
 * Process-local memory of the per-turn workspace skill sync: unchanged skill
 * files are stat'ed instead of read and hashed.
 *
 * Every entry is keyed on a file stamp (size, mtime, ctime, inode), so an
 * edited file never matches: a stale entry costs a re-hash, never a skipped
 * sync. Losing it (gateway restart) costs one full pass. NOT the guard's
 * verdict cache in `skills-guard.ts`, and NOT a watcher: nothing here runs
 * between turns.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSkillContentEntry } from './skills-guard-structure.js';

// 10k (skills-scan perf fix, 2026-10-01, untuned): one agent's synced copies
// plus their sources are ~750 files on a heavy install, so this holds about a
// dozen active agents. Eviction only costs a re-hash.
const MAX_CACHED_FILE_HASHES = 10_000;
// A stamp proves "unchanged" only once it is older than the coarsest
// filesystem timestamp tick (FAT: 2 s). A file touched more recently could be
// rewritten in the same tick at the same size, so it is not cached yet.
const RACY_STAMP_WINDOW_MS = 2_000;

const fileHashes = new Map<string, { stamp: string; hash: string }>();

function fileStamp(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

function setBounded<V>(
  map: Map<string, V>,
  key: string,
  value: V,
  max: number,
): void {
  map.delete(key);
  map.set(key, value);
  if (map.size <= max) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

function hashFileContent(filePath: string): string {
  const stat = fs.statSync(filePath);
  const stamp = fileStamp(stat);
  const cached = fileHashes.get(filePath);
  if (cached?.stamp === stamp) return cached.hash;

  // lgtm[js/insufficient-password-hash] This is a content-change
  // fingerprint, not password storage or credential derivation.
  const hash = createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
  if (
    Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) >
    RACY_STAMP_WINDOW_MS
  ) {
    setBounded(fileHashes, filePath, { stamp, hash }, MAX_CACHED_FILE_HASHES);
  }
  return hash;
}

export function buildDirectoryContentSignature(rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const entries: string[] = [];
  const stack = [resolvedRoot];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const dirEntries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      if (!isSkillContentEntry(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const relPath = path
        .relative(resolvedRoot, fullPath)
        .split(path.sep)
        .join('/');
      entries.push(`${relPath}:${hashFileContent(fullPath)}`);
    }
  }

  // lgtm[js/insufficient-password-hash] This aggregates content
  // fingerprints and is not a credential verifier.
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
