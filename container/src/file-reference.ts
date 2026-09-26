import fs from 'node:fs';

import {
  resolveMediaPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT_DISPLAY,
} from './runtime-paths.js';

// Tool arguments may carry `<file-base64:path>` instead of an inline base64
// payload. The runtime reads the file and substitutes the encoded bytes after
// the model has emitted the call, so binary uploads never have to travel
// through the model context. Mirrors the `<secret:NAME>` placeholder the
// gateway expands for HTTP requests.
const FILE_REFERENCE_RE = /^<file-base64:([^>]*)>$/;
const FILE_REFERENCE_MARKER = '<file-base64:';

export const FILE_REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;

export interface FileReferenceExpansion {
  path: string;
  bytes: number;
}

export class FileReferenceError extends Error {}

function allowedRootsHint(): string {
  return `${WORKSPACE_ROOT_DISPLAY}, /uploaded-media-cache, or /discord-media-cache`;
}

function readReferencedFile(rawPath: string): {
  base64: string;
  expansion: FileReferenceExpansion;
} {
  const requested = rawPath.trim();
  if (!requested) {
    throw new FileReferenceError(
      'file reference is empty. Use `<file-base64:path/to/file>`.',
    );
  }

  const resolved =
    resolveWorkspacePath(requested) || resolveMediaPath(requested);
  if (!resolved) {
    throw new FileReferenceError(
      `file reference \`${requested}\` must point under ${allowedRootsHint()}.`,
    );
  }
  if (!fs.existsSync(resolved)) {
    throw new FileReferenceError(`file reference not found: ${requested}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new FileReferenceError(`file reference is not a file: ${requested}`);
  }
  if (stat.size > FILE_REFERENCE_MAX_BYTES) {
    throw new FileReferenceError(
      `file reference \`${requested}\` is ${stat.size} bytes and exceeds the ${FILE_REFERENCE_MAX_BYTES}-byte limit.`,
    );
  }

  return {
    base64: fs.readFileSync(resolved).toString('base64'),
    expansion: { path: requested, bytes: stat.size },
  };
}

function expandStringValue(
  value: string,
  expansions: FileReferenceExpansion[],
): string {
  const match = FILE_REFERENCE_RE.exec(value);
  if (!match) {
    // A marker anywhere else means the model wrapped the reference in other
    // text. Splicing base64 into that string would produce a payload nobody
    // asked for, so this is an error rather than a silent partial expansion.
    if (value.includes(FILE_REFERENCE_MARKER)) {
      throw new FileReferenceError(
        'a `<file-base64:path>` reference must be the entire argument value, not embedded in a longer string.',
      );
    }
    return value;
  }

  const { base64, expansion } = readReferencedFile(match[1]);
  expansions.push(expansion);
  return base64;
}

function expandValue(
  value: unknown,
  expansions: FileReferenceExpansion[],
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return expandStringValue(value, expansions);
  if (Array.isArray(value)) {
    return value.map((entry) => expandValue(entry, expansions, depth + 1));
  }
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = expandValue(entry, expansions, depth + 1);
    }
    return next;
  }
  return value;
}

/**
 * Replace `<file-base64:path>` argument values with the referenced file's
 * base64 content. Returns the original object untouched when no reference is
 * present, so tools that never use the placeholder pay nothing.
 */
export function expandFileReferences<T extends Record<string, unknown>>(
  args: T,
): { args: T; expansions: FileReferenceExpansion[] } {
  const expansions: FileReferenceExpansion[] = [];
  const expanded = expandValue(args, expansions, 0) as T;
  return expansions.length > 0
    ? { args: expanded, expansions }
    : { args, expansions };
}
