import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export const INSTRUCTION_FILES = ['AGENTS.md', 'SECURITY.md', 'TRUST_MODEL.md'] as const;
export const INSTRUCTION_BASELINE_VERSION = 1;
export const INSTRUCTION_BASELINE_PATH = path.join(process.cwd(), 'data', 'audit', 'instruction-hashes.json');

export interface InstructionHashBaseline {
  version: number;
  approvedAt: string;
  files: Record<string, string>;
}

export type InstructionFileStatus = 'ok' | 'modified' | 'missing' | 'untracked';

export interface InstructionFileResult {
  path: string;
  expectedHash: string | null;
  actualHash: string | null;
  status: InstructionFileStatus;
}

export interface InstructionIntegrityResult {
  ok: boolean;
  baselinePath: string;
  baseline: InstructionHashBaseline | null;
  baselineError: string | null;
  files: InstructionFileResult[];
}

export function summarizeInstructionIntegrity(result: InstructionIntegrityResult): string {
  if (result.baselineError) return `baseline.invalid (${result.baselineError})`;
  if (!result.baseline) return 'baseline.missing';

  const changed = result.files.filter((file) => file.status !== 'ok');
  if (changed.length === 0) return 'no changes';
  return changed.map((file) => `${file.path}:${file.status}`).join(', ');
}

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function computeCurrentHashes(): Record<string, string | null> {
  const hashes: Record<string, string | null> = {};
  for (const relPath of INSTRUCTION_FILES) {
    const absPath = path.join(process.cwd(), relPath);
    hashes[relPath] = fs.existsSync(absPath) ? sha256File(absPath) : null;
  }
  return hashes;
}

export function loadInstructionBaseline(): InstructionHashBaseline | null {
  if (!fs.existsSync(INSTRUCTION_BASELINE_PATH)) return null;

  const raw = fs.readFileSync(INSTRUCTION_BASELINE_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error('Instruction baseline is not a JSON object.');

  const version = parsed.version;
  const approvedAt = parsed.approvedAt;
  const files = parsed.files;
  if (typeof version !== 'number') throw new Error('Instruction baseline is missing numeric `version`.');
  if (version !== INSTRUCTION_BASELINE_VERSION) {
    throw new Error(`Instruction baseline version ${String(version)} is unsupported.`);
  }
  if (typeof approvedAt !== 'string' || !approvedAt.trim()) {
    throw new Error('Instruction baseline is missing `approvedAt`.');
  }
  if (!isRecord(files)) throw new Error('Instruction baseline is missing `files` object.');

  const normalizedFiles: Record<string, string> = {};
  for (const relPath of INSTRUCTION_FILES) {
    const value = files[relPath];
    if (typeof value === 'string' && value.trim()) {
      normalizedFiles[relPath] = value.trim();
    }
  }

  return {
    version,
    approvedAt: approvedAt.trim(),
    files: normalizedFiles,
  };
}

export function approveInstructionBaseline(): InstructionHashBaseline {
  const hashes = computeCurrentHashes();
  const missing = INSTRUCTION_FILES.filter((relPath) => !hashes[relPath]);
  if (missing.length > 0) {
    throw new Error(`Approval failed: missing instruction files (${missing.join(', ')}).`);
  }

  const baseline: InstructionHashBaseline = {
    version: INSTRUCTION_BASELINE_VERSION,
    approvedAt: new Date().toISOString(),
    files: {},
  };

  for (const relPath of INSTRUCTION_FILES) {
    baseline.files[relPath] = hashes[relPath] as string;
  }

  fs.mkdirSync(path.dirname(INSTRUCTION_BASELINE_PATH), { recursive: true });
  const tmpPath = `${INSTRUCTION_BASELINE_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmpPath, INSTRUCTION_BASELINE_PATH);
  return baseline;
}

export function verifyInstructionBaseline(): InstructionIntegrityResult {
  const hashes = computeCurrentHashes();
  let baseline: InstructionHashBaseline | null = null;
  let baselineError: string | null = null;

  try {
    baseline = loadInstructionBaseline();
  } catch (err) {
    baselineError = err instanceof Error ? err.message : String(err);
  }

  const files: InstructionFileResult[] = INSTRUCTION_FILES.map((relPath) => {
    const actualHash = hashes[relPath];
    const expectedHash = baseline?.files[relPath] || null;

    if (!expectedHash) {
      return {
        path: relPath,
        expectedHash: null,
        actualHash,
        status: 'untracked',
      };
    }

    if (!actualHash) {
      return {
        path: relPath,
        expectedHash,
        actualHash: null,
        status: 'missing',
      };
    }

    if (actualHash === expectedHash) {
      return {
        path: relPath,
        expectedHash,
        actualHash,
        status: 'ok',
      };
    }

    return {
      path: relPath,
      expectedHash,
      actualHash,
      status: 'modified',
    };
  });

  const ok = baselineError === null && baseline !== null && files.every((file) => file.status === 'ok');
  return {
    ok,
    baselinePath: INSTRUCTION_BASELINE_PATH,
    baseline,
    baselineError,
    files,
  };
}
