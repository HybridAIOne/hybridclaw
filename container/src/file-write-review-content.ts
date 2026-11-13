/**
 * Revision-only review receives the exact text named by its byte precondition.
 * It uses the tool's workspace or task-container paths, rejects symlinks and
 * stale bytes before model delivery, and retains no snapshot after the call.
 * Unlike the write tool, this never mutates the target or grants permission.
 */
import fs from 'node:fs';
import { TASK_SANDBOX_FS_ENABLED } from './bash-process.js';
import {
  resolveTaskSandboxPath,
  resolveWorkspacePath,
} from './runtime-paths.js';
import { copyTaskSandboxFileToTemp } from './task-sandbox-files.js';
import { fileWriteRevision, isFileWriteRevision } from './tools/file-write.js';

export function readFileWriteReviewContent(
  userPath: string,
  revision: unknown,
): string {
  if (!isFileWriteRevision(revision)) throw new Error('Invalid file revision');
  const target = (
    TASK_SANDBOX_FS_ENABLED ? resolveTaskSandboxPath : resolveWorkspacePath
  )(userPath);
  if (!target) throw new Error('File review path escapes workspace');
  let temporary: string | undefined;
  try {
    let local = target;
    if (TASK_SANDBOX_FS_ENABLED) {
      const copied = copyTaskSandboxFileToTemp(target);
      local = copied.localPath;
      temporary = copied.tempDir;
    }
    if (!fs.lstatSync(local).isFile())
      throw new Error('File review requires a regular file');
    const current = fs.readFileSync(local);
    if (fileWriteRevision(current) !== revision)
      throw new Error('File review revision is stale');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      current,
    );
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
