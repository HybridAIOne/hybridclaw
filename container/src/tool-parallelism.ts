/**
 * Tool-batch concurrency policy: which calls of one model response may overlap.
 *
 * Only allowlisted reads, trusted MCP reads and path-scoped file tools batch.
 * Vision file inputs share file-tool claims; snapshots and remote inputs do not.
 * Every other tool is a barrier that runs alone, in model order, while the calls
 * around it still batch. A file tool joins a run only if its path does not
 * overlap a path in the run when either of the two writes.
 *
 * NOT approval or the loop guard: this never decides whether a call may run.
 */

import { BUILTIN_TOOLS } from '@hybridclaw/shared/builtin-tools';
import type { McpToolBehavior } from './mcp/types.js';
import { resolveReadToolPath } from './read-path.js';
import {
  fileToolPathIdentity,
  isWithinRoot,
  resolveFileToolGlob,
  resolveFileToolPath,
  TASK_SANDBOX_FS_ENABLED,
} from './runtime-paths.js';
import { parseToolArgsJson } from './tool-args.js';
import type { ToolCall } from './types.js';
import {
  normalizeVisionLocalPath,
  visionImageSources,
} from './vision-input.js';

// MCP reads require operator-trusted behavior.
const PARALLEL_SAFE_TOOLS = new Set(
  BUILTIN_TOOLS.filter((tool) => tool.parallelSafe).map((tool) => tool.name),
);
const PATH_READERS = new Set(['glob', 'grep', 'read', 'vision_analyze']);
const PATH_WRITERS = new Set(['delete', 'edit', 'write']);

interface PathClaim {
  path: string;
  writes: boolean;
}

/** The path a file tool touches, resolved the way the tool resolves it. */
function resolveToolPath(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  if (toolName === 'glob') {
    if (typeof args.pattern !== 'string') return null;
    return resolveFileToolGlob(args.pattern)?.root ?? null;
  }
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return toolName === 'grep' ? resolveFileToolPath('.') : null;
  }
  if (toolName === 'read') {
    try {
      return resolveReadToolPath(args.path);
    } catch {
      return null; // Execution reports invalid artifact references.
    }
  }
  return resolveFileToolPath(args.path);
}

function claimsForPath(path: string, writes: boolean): PathClaim[] {
  const identity = fileToolPathIdentity(path);
  const claims = [{ path, writes }];
  if (identity !== path) claims.push({ path: identity, writes });
  return claims;
}

/** Null when a file tool's paths are unknown; empty for vision inputs without local paths. */
function claimPaths(call: ToolCall): PathClaim[] | null {
  const toolName = call.function.name;
  const args = parseToolArgsJson(call.function.arguments);
  if (!args) return null;
  if (toolName === 'vision_analyze') {
    const { imageRef, fallbackUrl } = visionImageSources(args);
    if (args.snapshot !== undefined) return imageRef || fallbackUrl ? null : [];
    if (!imageRef) return null;
    const claims: PathClaim[] = [];
    for (const candidate of [imageRef, fallbackUrl].filter(Boolean)) {
      if (/^https?:\/\//i.test(candidate)) continue;
      try {
        // Local vision reads worker files, which may be mounted in the task container.
        if (TASK_SANDBOX_FS_ENABLED) return null;
        const path = normalizeVisionLocalPath(candidate);
        if (!path) return null;
        claims.push(...claimsForPath(path, false));
      } catch {
        // Execution reports invalid aliases; scheduling treats them as barriers.
        return null;
      }
    }
    return claims;
  }
  const path = resolveToolPath(toolName, args);
  return path ? claimsForPath(path, PATH_WRITERS.has(toolName)) : null;
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithinRoot(left, right) || isWithinRoot(right, left);
}

/**
 * The leading calls that may run together, in model order. The run ends
 * before the first barrier and before the first file tool that conflicts with
 * a path already in the run. Fewer than two calls means the first runs alone.
 */
export function leadingParallelRun(
  calls: readonly ToolCall[],
  resolveMcpBehavior?: (name: string) => McpToolBehavior | undefined,
): ToolCall[] {
  const run: ToolCall[] = [];
  const claims: PathClaim[] = [];
  for (const call of calls) {
    if (
      PATH_READERS.has(call.function.name) ||
      PATH_WRITERS.has(call.function.name)
    ) {
      const nextClaims = claimPaths(call);
      if (
        !nextClaims ||
        nextClaims.some((claim) =>
          claims.some(
            (held) =>
              (held.writes || claim.writes) &&
              pathsOverlap(held.path, claim.path),
          ),
        )
      )
        break;
      claims.push(...nextClaims);
    } else if (
      !PARALLEL_SAFE_TOOLS.has(call.function.name) &&
      resolveMcpBehavior?.(call.function.name)?.parallelSafe !== true
    ) {
      break;
    }
    run.push(call);
  }
  return run;
}

export function takeCachedValue<TKey, TValue>(
  cache: Map<TKey, TValue>,
  key: TKey,
): TValue | null {
  if (!cache.has(key)) return null;
  const value = cache.get(key) as TValue;
  cache.delete(key);
  return value;
}

export async function mapConcurrentInOrder<TItem, TResult>(
  items: readonly TItem[],
  worker: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  return Promise.all(items.map((item) => worker(item)));
}
