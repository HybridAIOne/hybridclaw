/**
 * Tool-batch concurrency policy: which calls of one model response may overlap.
 *
 * Only allowlisted reads, trusted MCP reads and path-scoped file tools batch.
 * Every other tool is a barrier that runs alone, in model order, while the calls
 * around it still batch. A file tool joins a run only if its path does not
 * overlap a path in the run when either of the two writes.
 *
 * NOT approval or the loop guard: this never decides whether a call may run.
 */

import type { McpToolBehavior } from './mcp/types.js';
import {
  isWithinRoot,
  resolveMediaPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
} from './runtime-paths.js';
import { parseToolArgsJson } from './tool-args.js';
import type { ToolCall } from './types.js';

// Engineering choice, 2026-09-26: hermes-agent's read-only allowlist mapped to
// HybridClaw's tools. Tools that write workspace artifacts (image_generate,
// diagram_create) stay barriers. MCP reads require operator-trusted behavior.
const READ_ONLY_TOOLS = new Set([
  'device_data',
  'session_search',
  'skills_list',
  'vision_analyze',
  'web_extract',
  'web_fetch',
  'web_search',
]);
const PATH_READERS = new Set(['glob', 'grep', 'read']);
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
    // A glob reads the fixed directory before its first wildcard segment.
    const segments = args.pattern.replace(/\\/g, '/').split('/');
    const wildcard = segments.findIndex((segment) => /[*?[{]/.test(segment));
    if (wildcard === -1) return resolveWorkspacePath(args.pattern);
    return resolveWorkspacePath(segments.slice(0, wildcard).join('/') || '.');
  }
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return toolName === 'grep' ? WORKSPACE_ROOT : null;
  }
  const workspacePath = resolveWorkspacePath(args.path);
  if (workspacePath || toolName !== 'read') return workspacePath;
  return resolveMediaPath(args.path);
}

/** Null for a call that is not a file tool or whose path is unknown. */
function claimPath(call: ToolCall): PathClaim | null {
  const toolName = call.function.name;
  const writes = PATH_WRITERS.has(toolName);
  if (!writes && !PATH_READERS.has(toolName)) return null;
  const args = parseToolArgsJson(call.function.arguments);
  const path = args && resolveToolPath(toolName, args);
  return path ? { path, writes } : null;
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
      !READ_ONLY_TOOLS.has(call.function.name) &&
      resolveMcpBehavior?.(call.function.name)?.parallelSafe !== true
    ) {
      const claim = claimPath(call);
      if (
        !claim ||
        claims.some(
          (held) =>
            (held.writes || claim.writes) &&
            pathsOverlap(held.path, claim.path),
        )
      ) {
        break;
      }
      claims.push(claim);
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
