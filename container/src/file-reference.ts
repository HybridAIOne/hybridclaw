/**
 * File references in tool arguments — the one route for bytes that must not
 * enter the model context.
 *
 * A `<file-base64:path>` value is substituted exactly once, after approval and
 * the before-tool hooks have judged the model-authored call, so those see the
 * reference and never the payload; what they miss is always base64, never the
 * referenced file's own text. Only tools whose arguments leave the sandbox
 * (MCP, plugin tools, `http_request`) expand it; elsewhere it is an error. Not
 * the gateway's `<secret:NAME>` expansion, which resolves credentials this
 * process is deliberately never given.
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

// 8 MB (snoller, 2026-09-26, #1591): far above the 92 KB file that failed in
// production, and still inside the HybridAI connector's 50 MB request limit
// once base64 adds a third. Streaming or presigned transfer (MCP SEP-2631)
// is deferred until a file this size is actually needed.
export const FILE_REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 8;

// The other half of the same policy: reject binary payloads that were pasted
// into an argument by hand, so the reference above stays the only way in.
// A model cannot reproduce six figures of base64 verbatim, and the tool it
// hands the payload to reports success either way, so the corruption only
// surfaces wherever the file finally lands.
// 8k characters (snoller, 2026-09-26, #1591): a small hand-written payload
// such as a test fixture stays allowed; anything larger takes a reference.
export const INLINE_BASE64_MAX_CHARS = 8 * 1024;
const TRUNCATED_BASE64_MIN_CHARS = 24;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URL_BASE64_RE = /^data:[^,]*;base64,/i;
const ELLIPSIS_RE = /\.{3}|…/;

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

  // Reads this process's filesystem. In the terminal-bench `docker-exec` bash
  // mode, files that bash writes live in the task container instead, so a
  // reference to one does not resolve; `read` copies them out with `docker cp`.
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

// Encoded binary this long all but always mixes digits with both letter
// cases. Abbreviated hex hashes (`e45bdf4b1…`), compare ranges made of plain
// names (`develop...release/candidateVersion`), and filler such as a long run
// of one letter do not, and are left alone.
function looksEncoded(candidate: string): boolean {
  return (
    /\d/.test(candidate) && /[a-z]/.test(candidate) && /[A-Z]/.test(candidate)
  );
}

function checkPastedPayload(value: string): void {
  if (ELLIPSIS_RE.test(value)) {
    const withoutEllipsis = base64Payload(value.split(ELLIPSIS_RE).join(''));
    if (
      withoutEllipsis &&
      withoutEllipsis.length >= TRUNCATED_BASE64_MIN_CHARS &&
      looksEncoded(withoutEllipsis)
    ) {
      throw new FileReferenceError(
        'an argument contains an abbreviated base64 payload ("..."). Pass the file as `<file-base64:path>` instead of transcribing its bytes.',
      );
    }
    return;
  }

  const payload = base64Payload(value);
  if (
    payload &&
    payload.length > INLINE_BASE64_MAX_CHARS &&
    looksEncoded(payload)
  ) {
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

/**
 * The dispatch-time entry point: reject pasted payloads in what the model
 * wrote, then expand references for a tool that sends its arguments out of
 * the sandbox. Anywhere else the expansion could only turn a reference into
 * base64 text in a local file, a chat message, or another model's context.
 */
export function prepareToolArguments<T extends Record<string, unknown>>(
  toolName: string,
  args: T,
  options: { acceptsFileReferences: boolean },
): { args: T; expansions: FileReferenceExpansion[] } | { error: string } {
  try {
    assertNoPastedBinaryPayload(args);
    if (options.acceptsFileReferences) return expandFileReferences(args);
    visitStrings(args, 0, (value) => {
      if (!value.includes(FILE_REFERENCE_MARKER)) return;
      throw new FileReferenceError(
        `\`${toolName}\` does not expand \`<file-base64:path>\`; only MCP tools, plugin tools, and \`http_request\` do, because they send their arguments out of the sandbox. Pass the file path in this tool's own path parameter instead, if it has one.`,
      );
    });
    return { args, expansions: [] };
  } catch (err) {
    if (err instanceof FileReferenceError) return { error: err.message };
    throw err;
  }
}

/**
 * Tell the model which files a successful call actually sent, so it can check
 * the size against what the destination reports instead of assuming success.
 */
export function appendFileReferenceReceipt(
  output: string,
  expansions: FileReferenceExpansion[],
): string {
  if (expansions.length === 0) return output;
  const receipt = expansions
    .map(
      (expansion) =>
        `[file-base64: sent ${expansion.path} (${expansion.bytes} bytes)]`,
    )
    .join('\n');
  return `${output}\n\n${receipt}`;
}
