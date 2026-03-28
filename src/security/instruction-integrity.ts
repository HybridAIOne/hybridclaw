import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import {
  resolveInstallPath,
  resolveInstallRoot,
} from '../infra/install-root.js';

const INSTRUCTION_SPECS = [
  {
    path: 'SECURITY.md',
    sourceRelativePath: 'SECURITY.md',
  },
  {
    path: 'TRUST_MODEL.md',
    sourceRelativePath: 'TRUST_MODEL.md',
  },
] as const;

export const INSTRUCTION_FILES = INSTRUCTION_SPECS.map((spec) => spec.path);
export const INSTRUCTION_RUNTIME_DIR = path.join(
  DEFAULT_RUNTIME_HOME_DIR,
  'instructions',
);

type InstructionPath = (typeof INSTRUCTION_SPECS)[number]['path'];
type InstructionSpec = (typeof INSTRUCTION_SPECS)[number];

export type InstructionFileStatus =
  | 'ok'
  | 'modified'
  | 'missing'
  | 'source_missing';

export interface InstructionFileResult {
  path: InstructionPath;
  sourcePath: string;
  runtimePath: string;
  expectedHash: string | null;
  actualHash: string | null;
  status: InstructionFileStatus;
}

export interface InstructionIntegrityResult {
  ok: boolean;
  installRoot: string;
  runtimeRoot: string;
  files: InstructionFileResult[];
}

export interface InstructionSyncResult {
  syncedAt: string;
  runtimeRoot: string;
  files: Record<InstructionPath, string>;
}

export function summarizeInstructionIntegrity(
  result: InstructionIntegrityResult,
): string {
  const changed = result.files.filter((file) => file.status !== 'ok');
  if (changed.length === 0) return 'no changes';
  return changed.map((file) => `${file.path}:${file.status}`).join(', ');
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function resolveSourcePath(spec: InstructionSpec): string {
  return resolveInstallPath(spec.sourceRelativePath);
}

export function resolveRuntimeInstructionPath(
  relPath: InstructionPath,
): string {
  return path.join(INSTRUCTION_RUNTIME_DIR, relPath);
}

export function ensureRuntimeInstructionCopies(): void {
  fs.mkdirSync(INSTRUCTION_RUNTIME_DIR, { recursive: true });
  for (const spec of INSTRUCTION_SPECS) {
    const sourcePath = resolveSourcePath(spec);
    const runtimePath = resolveRuntimeInstructionPath(spec.path);
    if (!fs.existsSync(sourcePath) || fs.existsSync(runtimePath)) continue;
    fs.copyFileSync(sourcePath, runtimePath);
  }
}

export function syncRuntimeInstructionCopies(): InstructionSyncResult {
  fs.mkdirSync(INSTRUCTION_RUNTIME_DIR, { recursive: true });

  const files = {} as Record<InstructionPath, string>;
  for (const spec of INSTRUCTION_SPECS) {
    const sourcePath = resolveSourcePath(spec);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing source instruction file: ${sourcePath}`);
    }
    const runtimePath = resolveRuntimeInstructionPath(spec.path);
    fs.copyFileSync(sourcePath, runtimePath);
    files[spec.path] = sha256File(runtimePath);
  }

  return {
    syncedAt: new Date().toISOString(),
    runtimeRoot: INSTRUCTION_RUNTIME_DIR,
    files,
  };
}

export function readRuntimeInstructionFile(relPath: InstructionPath): string {
  ensureRuntimeInstructionCopies();
  const runtimePath = resolveRuntimeInstructionPath(relPath);
  return fs.readFileSync(runtimePath, 'utf-8').trim();
}

export function verifyInstructionIntegrity(): InstructionIntegrityResult {
  ensureRuntimeInstructionCopies();

  const files: InstructionFileResult[] = INSTRUCTION_SPECS.map((spec) => {
    const sourcePath = resolveSourcePath(spec);
    const runtimePath = resolveRuntimeInstructionPath(spec.path);
    const expectedHash = fs.existsSync(sourcePath)
      ? sha256File(sourcePath)
      : null;
    const actualHash = fs.existsSync(runtimePath)
      ? sha256File(runtimePath)
      : null;

    if (!expectedHash) {
      return {
        path: spec.path,
        sourcePath,
        runtimePath,
        expectedHash: null,
        actualHash,
        status: 'source_missing',
      };
    }

    if (!actualHash) {
      return {
        path: spec.path,
        sourcePath,
        runtimePath,
        expectedHash,
        actualHash: null,
        status: 'missing',
      };
    }

    if (actualHash === expectedHash) {
      return {
        path: spec.path,
        sourcePath,
        runtimePath,
        expectedHash,
        actualHash,
        status: 'ok',
      };
    }

    return {
      path: spec.path,
      sourcePath,
      runtimePath,
      expectedHash,
      actualHash,
      status: 'modified',
    };
  });

  return {
    ok: files.every((file) => file.status === 'ok'),
    installRoot: resolveInstallRoot(),
    runtimeRoot: INSTRUCTION_RUNTIME_DIR,
    files,
  };
}
