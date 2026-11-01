/**
 * File writes create exclusively unless an explicit replacement matches current bytes.
 * Unlike approval policy, this checks file state; it grants no path access or approval.
 * Cooperative locks serialize tool writers, not external editors or shell commands.
 */
import fs from 'node:fs';
import { writeFileAtomicExclusive } from '../../shared/atomic-write.js';
import {
  lockMemoryFile,
  writeMemoryFileAtomic,
} from '../../shared/memory-file.js';
import {
  recordFileWriteConflict,
  resolveFileWriteConflict,
} from '../file-write-conflicts.js';
import type { ToolDefinition } from '../types.js';
import { fileSyntaxFeedback } from './file-syntax-feedback.js';

export const WRITE_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write',
    description:
      'Create a new text file. Existing files are protected: intentional replacement requires overwrite=true and expected_content matching the entire current file exactly. Read the file first; on mismatch, read again and reconsider the replacement. Use edit for targeted changes. Use write for new code/program files instead of shell heredocs or code-only replies.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        contents: { type: 'string', description: 'Content to write' },
        overwrite: {
          type: 'boolean',
          description:
            'Default false. Set true only for intentional replacement.',
        },
        expected_content: {
          type: 'string',
          description:
            'Required with overwrite=true: exact full current file content, including whitespace and trailing newlines. A mismatch or missing file fails without writing.',
        },
      },
      required: ['path', 'contents'],
    },
  },
};

// Task images provide bash/coreutils, but need not have a Node runtime. Checks
// and publication stay in one sandbox command, under the same .lock convention.
const SANDBOX_WRITE = `set -euo pipefail
IFS= read -r -d '' target
IFS= read -r -d '' overwrite
IFS= read -r -d '' expected
IFS= read -r -d '' contents
mkdir -p -- "$(dirname -- "$target")"
mkdir -- "$target.lock" || { echo 'File is locked; retry after the writer finishes.' >&2; exit 1; }
stage=''
trap 'rm -rf -- "$stage"; rmdir -- "$target.lock"' EXIT
stage=$(mktemp -d "$(dirname -- "$target")/.hybridclaw-write.XXXXXX")
printf '%s' "$contents" | base64 -d > "$stage/content"
if [ "$overwrite" = true ]; then
  [ ! -L "$target" ] && [ -f "$target" ] || { echo 'Replacement requires an existing regular file.' >&2; exit 1; }
  printf '%s' "$expected" | base64 -d > "$stage/expected"
  cmp -s -- "$stage/expected" "$target" || { echo 'Stale write: expected_content does not match; read the file again.' >&2; exit 1; }
  chmod --reference="$target" -- "$stage/content"
  mv -fT -- "$stage/content" "$target"
else
  ln -T -- "$stage/content" "$target" || { echo 'File already exists or cannot be created; use a separate path for a new deliverable, or checked replacement.' >&2; exit 1; }
fi`;

export function runFileWrite(
  args: Record<string, unknown>,
  resolvePath: (userPath: string) => string | null,
  sandbox?: {
    container: string;
    run: (params: { args: string[]; input: string }) => {
      status: number | null;
      stdout: string;
      stderr: string;
      error?: Error;
    };
  },
  sessionId = '',
): string {
  if (
    typeof args.path !== 'string' ||
    !args.path.trim() ||
    args.path.includes('\0')
  ) {
    throw new Error('path must be a non-empty file path');
  }
  if (typeof args.contents !== 'string') {
    throw new Error('contents must be a string');
  }
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') {
    throw new Error('overwrite must be a boolean');
  }
  const overwrite = args.overwrite === true;
  const target = resolvePath(args.path);
  if (!target) throw new Error(`Path escapes workspace: ${args.path}`);
  try {
    if (overwrite && typeof args.expected_content !== 'string') {
      throw new Error(
        'Replacement requires expected_content matching the entire current file',
      );
    }
    if (!overwrite && args.expected_content !== undefined) {
      throw new Error('expected_content requires overwrite=true');
    }
    if (sandbox) {
      const result = sandbox.run({
        args: ['exec', '-i', sandbox.container, 'bash', '-c', SANDBOX_WRITE],
        input: [
          target,
          String(overwrite),
          Buffer.from(
            overwrite ? (args.expected_content as string) : '',
          ).toString('base64'),
          Buffer.from(args.contents).toString('base64'),
        ]
          .map((field) => `${field}\0`)
          .join(''),
      });
      if (result.status !== 0) {
        throw new Error(
          result.stderr.trim() ||
            result.error?.message ||
            'Failed to write task sandbox file',
        );
      }
    } else {
      const release = lockMemoryFile(target);
      try {
        if (overwrite) {
          const stat = fs.lstatSync(target, { throwIfNoEntry: false });
          if (!stat?.isFile()) {
            throw new Error('Replacement requires an existing regular file');
          }
          if (
            !fs
              .readFileSync(target)
              .equals(Buffer.from(args.expected_content as string))
          ) {
            throw new Error(
              'Stale write: expected_content does not match; read the file again',
            );
          }
          writeMemoryFileAtomic(target, args.contents);
        } else {
          try {
            writeFileAtomicExclusive(target, args.contents);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
            throw new Error(
              'File already exists; use a separate path for a new deliverable, or intentional overwrite=true with exact expected_content',
            );
          }
        }
      } finally {
        release();
      }
    }
  } catch (error) {
    recordFileWriteConflict(sessionId, args.path);
    throw error;
  }
  resolveFileWriteConflict(sessionId, args.path);
  return `Wrote ${Buffer.byteLength(args.contents)} bytes to ${args.path}${fileSyntaxFeedback(args.path, args.contents)}`;
}
