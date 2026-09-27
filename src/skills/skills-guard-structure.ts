/**
 * Skill guard structure walk — the one pass over a skill directory that
 * decides what counts as skill content and flags what text rules cannot see:
 * symlinks leaving the skill, binaries, stray executable bits, size limits.
 *
 * `SKILL_IGNORED_ENTRIES` are skipped here and in the workspace sync
 * (`syncSkillIntoWorkspace`), so nothing reaches the agent unscanned. NOT the
 * text scan: rule matching lives in `skills-guard.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SkillGuardFinding } from './skills-guard.js';

export interface SkillFileEntry {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
  mtimeMs: number;
  mode: number;
  isBinary: boolean;
  /** Starts with `#!`: a script whatever its name, so the text scan reads it. */
  hasShebang: boolean;
}

export interface StructureScanState {
  files: SkillFileEntry[];
  findings: SkillGuardFinding[];
  fileCount: number;
  totalSize: number;
  signatureParts: string[];
}

const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_BYTES = 1_024 * 1_024;
const MAX_SINGLE_FILE_BYTES = 256 * 1_024;

const SUSPICIOUS_BINARY_EXTENSIONS = new Set<string>([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dat',
  '.com',
  '.msi',
  '.dmg',
  '.app',
  '.deb',
  '.rpm',
]);

const SCRIPT_EXEC_EXTENSIONS = new Set<string>([
  '.sh',
  '.bash',
  '.py',
  '.rb',
  '.pl',
]);

/** VCS metadata left out of both the scan and the workspace sync. */
export const SKILL_IGNORED_ENTRIES: ReadonlySet<string> = new Set(['.git']);

// Images and fonts are ordinary skill assets. A file is exempt from
// `binary_file` only with a media extension AND a media signature, so a
// renamed executable is still flagged.
const MEDIA_ASSET_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
]);

const MEDIA_SIGNATURES: readonly Buffer[] = [
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from('GIF8'),
  Buffer.from('RIFF'), // WebP container
  Buffer.from([0x00, 0x00, 0x01, 0x00]), // ICO
  Buffer.from([0x00, 0x01, 0x00, 0x00]), // TrueType
  Buffer.from('OTTO'), // OpenType
  Buffer.from('wOFF'),
  Buffer.from('wOF2'),
];

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeRealPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function readFileHead(filePath: string): Buffer {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const sample = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
      return sample.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return Buffer.alloc(0);
  }
}

function isLikelyBinary(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.includes(0)) return true;
  let suspicious = 0;
  for (const byte of head) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / head.length > 0.3;
}

function isMediaAsset(extension: string, head: Buffer): boolean {
  return (
    MEDIA_ASSET_EXTENSIONS.has(extension) &&
    MEDIA_SIGNATURES.some((signature) =>
      head.subarray(0, signature.length).equals(signature),
    )
  );
}

export function collectStructure(skillPath: string): StructureScanState {
  const rootReal = safeRealPath(skillPath);
  const state: StructureScanState = {
    files: [],
    findings: [],
    fileCount: 0,
    totalSize: 0,
    signatureParts: [],
  };

  const pendingDirs: string[] = [skillPath];
  const visitedDirs = new Set<string>([rootReal]);

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (SKILL_IGNORED_ENTRIES.has(entry.name)) continue;
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(skillPath, absolutePath) || entry.name;

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        state.fileCount += 1;
        let resolved: string | null = null;
        try {
          resolved = fs.realpathSync(absolutePath);
        } catch {
          resolved = null;
        }
        state.signatureParts.push(
          `L:${relativePath}:${Math.trunc(stat.mtimeMs)}:${resolved || 'BROKEN'}`,
        );

        if (!resolved) {
          state.findings.push({
            patternId: 'broken_symlink',
            severity: 'medium',
            category: 'structural',
            file: relativePath,
            line: 0,
            match: 'broken symlink',
            description: 'broken or circular symlink',
          });
          continue;
        }

        if (!pathWithin(rootReal, resolved)) {
          state.findings.push({
            patternId: 'symlink_escape',
            severity: 'critical',
            category: 'structural',
            file: relativePath,
            line: 0,
            match: `symlink -> ${resolved}`,
            description: 'symlink points outside the skill directory',
          });
        }
        continue;
      }

      if (stat.isDirectory()) {
        const resolvedDir = safeRealPath(absolutePath);
        state.signatureParts.push(
          `D:${relativePath}:${Math.trunc(stat.mtimeMs)}`,
        );
        if (!visitedDirs.has(resolvedDir)) {
          visitedDirs.add(resolvedDir);
          pendingDirs.push(absolutePath);
        }
        continue;
      }

      if (!stat.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      const head = readFileHead(absolutePath);
      const isBinary = isLikelyBinary(head);

      state.fileCount += 1;
      state.totalSize += stat.size;
      state.signatureParts.push(
        `F:${relativePath}:${stat.size}:${Math.trunc(stat.mtimeMs)}:${stat.mode}:${isBinary ? 1 : 0}`,
      );

      state.files.push({
        absolutePath,
        relativePath,
        extension: ext,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: stat.mode,
        isBinary,
        hasShebang: head[0] === 0x23 && head[1] === 0x21,
      });

      if (stat.size > MAX_SINGLE_FILE_BYTES) {
        state.findings.push({
          patternId: 'oversized_file',
          severity: 'medium',
          category: 'structural',
          file: relativePath,
          line: 0,
          match: `${Math.trunc(stat.size / 1024)}KB`,
          description: `file is ${Math.trunc(stat.size / 1024)}KB (limit: ${Math.trunc(MAX_SINGLE_FILE_BYTES / 1024)}KB)`,
        });
      }

      if (
        SUSPICIOUS_BINARY_EXTENSIONS.has(ext) ||
        (isBinary && !isMediaAsset(ext, head))
      ) {
        state.findings.push({
          patternId: 'binary_file',
          severity: 'critical',
          category: 'structural',
          file: relativePath,
          line: 0,
          match: isBinary
            ? `binary content${ext ? ` (${ext})` : ''}`
            : `binary extension: ${ext}`,
          description: 'binary/executable content should not be in a skill',
        });
      }

      if (!SCRIPT_EXEC_EXTENSIONS.has(ext) && (stat.mode & 0o111) !== 0) {
        state.findings.push({
          patternId: 'unexpected_executable',
          severity: 'medium',
          category: 'structural',
          file: relativePath,
          line: 0,
          match: 'executable bit set',
          description:
            'file has executable permission but is not a recognized script type',
        });
      }
    }
  }

  if (state.fileCount > MAX_FILE_COUNT) {
    state.findings.push({
      patternId: 'too_many_files',
      severity: 'medium',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${state.fileCount} files`,
      description: `skill has ${state.fileCount} files (limit: ${MAX_FILE_COUNT})`,
    });
  }

  if (state.totalSize > MAX_TOTAL_SIZE_BYTES) {
    state.findings.push({
      patternId: 'oversized_skill',
      severity: 'high',
      category: 'structural',
      file: '(directory)',
      line: 0,
      match: `${Math.trunc(state.totalSize / 1024)}KB total`,
      description: `skill is ${Math.trunc(state.totalSize / 1024)}KB total (limit: ${Math.trunc(MAX_TOTAL_SIZE_BYTES / 1024)}KB)`,
    });
  }

  return state;
}
