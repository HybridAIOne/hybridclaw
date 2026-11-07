/**
 * Atomic file writes: readers see the old file or the complete new one, never
 * a partial write. Every write stages a uniquely named temp file beside the
 * target, so concurrent writers never share a temp path, and the temp file is
 * removed when the write fails.
 *
 * NOT a lock: two concurrent replace-writes both succeed and the last rename
 * wins. Callers that read, modify and write need their own lock
 * (`memory-file.ts`). No fsync; a crash can still lose the latest write.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicWriteOptions {
  /** Exact mode of the written file (applied with chmod, so umask is ignored). */
  mode?: number;
  /** Mode for parent directories this write creates. */
  dirMode?: number;
}

function tempPathFor(targetPath: string): string {
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${randomUUID()}.tmp`,
  );
}

function mkdirOptions(options: AtomicWriteOptions): fs.MakeDirectoryOptions {
  return options.dirMode === undefined
    ? { recursive: true }
    : { recursive: true, mode: options.dirMode };
}

function writeTemp(
  tempPath: string,
  content: string | Uint8Array,
  mode: number | undefined,
): void {
  fs.writeFileSync(tempPath, content, { flag: 'wx', mode });
  if (mode !== undefined) fs.chmodSync(tempPath, mode);
}

/** Creates or replaces `targetPath`. */
export function writeFileAtomic(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(targetPath), mkdirOptions(options));
  const tempPath = tempPathFor(targetPath);
  try {
    writeTemp(tempPath, content, options.mode);
    fs.renameSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

export async function writeFileAtomicAsync(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await fs.promises.mkdir(path.dirname(targetPath), mkdirOptions(options));
  const tempPath = tempPathFor(targetPath);
  try {
    await fs.promises.writeFile(tempPath, content, {
      flag: 'wx',
      mode: options.mode,
    });
    if (options.mode !== undefined)
      await fs.promises.chmod(tempPath, options.mode);
    await fs.promises.rename(tempPath, targetPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true });
  }
}

/** Creates `targetPath`; throws `EEXIST` instead of replacing an existing file. */
export function writeFileAtomicExclusive(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  fs.mkdirSync(path.dirname(targetPath), mkdirOptions(options));
  const tempPath = tempPathFor(targetPath);
  try {
    writeTemp(tempPath, content, options.mode);
    fs.linkSync(tempPath, targetPath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
