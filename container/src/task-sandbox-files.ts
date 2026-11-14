/**
 * Task-container copies preserve the read tool's filesystem and failure semantics.
 * Callers resolve allowed paths and remove returned temporary copies; this grants
 * no approval and does not interpret file content or execute agent commands.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BASH_DOCKER_CONTAINER,
  BASH_EXEC_MAX_BUFFER_BYTES,
} from './bash-process.js';
import { replaceWorkspaceRootInOutput } from './runtime-paths.js';
import { failTool } from './tool-errors.js';

export function runTaskSandboxDocker(params: {
  args: string[];
  timeoutMs?: number;
  input?: string;
}): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
} {
  const result = spawnSync('docker', params.args, {
    encoding: 'utf-8',
    input: params.input,
    timeout: params.timeoutMs,
    maxBuffer: BASH_EXEC_MAX_BUFFER_BYTES,
    env: { ...process.env },
  });
  return {
    status: typeof result.status === 'number' ? result.status : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ?? undefined,
  };
}

export function copyTaskSandboxFileToTemp(sandboxPath: string): {
  tempDir: string;
  localPath: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-taskfs-'));
  const localPath = path.join(
    tempDir,
    path.posix.basename(sandboxPath) || 'file',
  );
  const result = runTaskSandboxDocker({
    args: ['cp', `${BASH_DOCKER_CONTAINER}:${sandboxPath}`, localPath],
  });
  if (result.status !== 0) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (/no such file|could not find|not found/i.test(detail)) {
      failTool(
        `Error: File not found: ${replaceWorkspaceRootInOutput(sandboxPath)}`,
      );
    }
    failTool(
      `Error: ${detail.trim() || 'Failed to copy file from task sandbox'}`,
    );
  }
  return { tempDir, localPath };
}
