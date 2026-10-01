/**
 * Process-local memory of the per-turn workspace skill sync. Unchanged skill
 * files are stat'ed instead of read and hashed, and promotion can tell a skill
 * the agent wrote from a synced catalog copy without resolving the catalog.
 *
 * Every entry is keyed on a file stamp (size, mtime, ctime, inode), so an
 * edited file never matches: a stale entry costs a re-hash or one full
 * catalog scan, never a skipped sync. Losing it (gateway restart) costs one
 * full pass. NOT the guard's verdict cache in `skills-guard.ts`, and NOT a
 * watcher: nothing here runs between turns.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSkillContentEntry } from './skills-guard-structure.js';

// Sizes chosen with the skills-scan perf fix (2026-10-01), untuned: one
// agent's synced copies plus their sources are ~750 files on a heavy install,
// so 10k hashes hold about a dozen active agents, and 256 workspace records
// are far above the agents one gateway serves. Eviction only costs a re-hash
// or one full promotion scan.
const MAX_CACHED_FILE_HASHES = 10_000;
const MAX_RECORDED_WORKSPACES = 256;
// A stamp proves "unchanged" only once it is older than the coarsest
// filesystem timestamp tick (FAT: 2 s). A file touched more recently could be
// rewritten in the same tick at the same size, so it is not cached yet.
const RACY_STAMP_WINDOW_MS = 2_000;

const fileHashes = new Map<string, { stamp: string; hash: string }>();
const resolvedSkillDirStamps = new Map<string, ReadonlyMap<string, string>>();

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

  // The per-file hashes already fingerprint the content, and the signature is
  // only compared within this process, so their list is the signature.
  return entries.join('\n');
}

/**
 * Records the SKILL.md stamps of the skill dirs `loadSkills` just placed or
 * verified inside `workspaceDir`, replacing that workspace's previous record.
 */
export function recordResolvedWorkspaceSkills(
  workspaceDir: string,
  skillFiles: readonly string[],
): void {
  const stamps = new Map<string, string>();
  for (const skillFile of skillFiles) {
    try {
      stamps.set(
        path.dirname(path.resolve(skillFile)),
        fileStamp(fs.statSync(skillFile)),
      );
    } catch {
      // Gone already: promotion then treats the dir as unknown.
    }
  }
  setBounded(
    resolvedSkillDirStamps,
    path.resolve(workspaceDir),
    stamps,
    MAX_RECORDED_WORKSPACES,
  );
}

/**
 * Whether `skillDir` is a catalog skill the last `loadSkills` resolved in
 * `workspaceDir` and its SKILL.md is untouched since.
 */
export function isResolvedWorkspaceSkillUnchanged(
  workspaceDir: string,
  skillDir: string,
): boolean {
  const stamp = resolvedSkillDirStamps
    .get(path.resolve(workspaceDir))
    ?.get(path.resolve(skillDir));
  if (stamp === undefined) return false;
  try {
    return fileStamp(fs.statSync(path.join(skillDir, 'SKILL.md'))) === stamp;
  } catch {
    return false;
  }
}
