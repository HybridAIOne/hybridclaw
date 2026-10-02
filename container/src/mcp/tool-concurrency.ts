/**
 * MCP scheduling trusts operator declarations, never inferred tool names.
 * Unlike tool-classifier, this grants overlap only, not approval or retries;
 * mutations and conflicting server hints always remain batch barriers.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from './types.js';

export function isParallelSafeMcpTool(
  config: McpServerConfig,
  originalName: string,
  annotations?: ToolAnnotations,
): boolean {
  if (
    annotations?.readOnlyHint === false ||
    annotations?.destructiveHint === true
  ) {
    return false;
  }
  const behavior = config.toolBehavior;
  const override =
    behavior?.overrides && Object.hasOwn(behavior.overrides, originalName)
      ? behavior.overrides[originalName]
      : undefined;
  if (override !== undefined) return override === 'read-only';
  return (
    behavior?.trustAnnotations === true && annotations?.readOnlyHint === true
  );
}
