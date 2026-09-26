/**
 * File references in tool arguments — the one route for bytes that must not
 * enter the model context.
 *
 * A `<file-base64:path>` value is substituted exactly once, after approval and
 * the before-tool hooks have judged the model-authored call, so those see the
 * reference and never the payload; what they miss is always base64, never the
 * referenced file's own text. Not the gateway's `<secret:NAME>` expansion,
 * which resolves credentials this process is deliberately never given.
 */

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

// The other half of the same policy: reject binary payloads that were pasted
// into an argument by hand, so the reference above stays the only way in.
// A model cannot reproduce six figures of base64 verbatim, and the tool it
// hands the payload to reports success either way, so the corruption only
// surfaces wherever the file finally lands.
export const INLINE_BASE64_MAX_CHARS = 8 * 1024;
const TRUNCATED_BASE64_MIN_CHARS = 24;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_BASE64_RE = /^data:[^,]*;base64,/i;
const ELLIPSIS_RE = /\.{3}|…/g;

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

function base64Payload(value: string): string | null {
  const withoutDataUrl = value.replace(DATA_URL_BASE64_RE, '');
  // Encoders wrap at 76 columns, so line breaks stay in. Spaces and tabs do
  // not, which is what keeps ordinary prose out of this check.
  const candidate = withoutDataUrl.replace(/[\r\n]/g, '');
  if (!candidate) return null;
  return BASE64_BODY_RE.test(candidate) ? candidate : null;
}

function checkPastedPayload(value: string): void {
  if (ELLIPSIS_RE.test(value)) {
    ELLIPSIS_RE.lastIndex = 0;
    const withoutEllipsis = base64Payload(value.replace(ELLIPSIS_RE, ''));
    if (
      withoutEllipsis &&
      withoutEllipsis.length >= TRUNCATED_BASE64_MIN_CHARS
    ) {
      throw new FileReferenceError(
        'an argument contains an abbreviated base64 payload ("..."). Pass the file as `<file-base64:path>` instead of transcribing its bytes.',
      );
    }
    ELLIPSIS_RE.lastIndex = 0;
    return;
  }

  const payload = base64Payload(value);
  if (payload && payload.length > INLINE_BASE64_MAX_CHARS) {
    throw new FileReferenceError(
      `an argument carries a ${payload.length}-character inline base64 payload, over the ${INLINE_BASE64_MAX_CHARS}-character limit. Write the bytes to a file and pass \`<file-base64:path>\`; a payload this size does not survive being written out token by token.`,
    );
  }
}

function visitStrings(
  value: unknown,
  depth: number,
  visit: (value: string) => void,
): void {
  if (depth > MAX_DEPTH) return;
  if (typeof value === 'string') {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) visitStrings(entry, depth + 1, visit);
    return;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) {
      visitStrings(entry, depth + 1, visit);
    }
  }
}

/**
 * Reject arguments that carry a hand-written binary payload. Runs before
 * expansion, so the base64 a reference produces is never its own subject.
 */
export function assertNoPastedBinaryPayload(
  args: Record<string, unknown>,
): void {
  visitStrings(args, 0, checkPastedPayload);
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
