/**
 * Provider tool-count caps: the one place a provider's maximum `tools` array
 * length is defined.
 *
 * Over the cap, every MCP tool joins the deferred set that `tool-catalog.ts`
 * keeps behind `tool_catalog`; this module widens that set, it is not a second
 * deferral mechanism. A request still over the cap after deferral fails before
 * it is sent, since the provider would reject it on every attempt. Providers
 * without a documented cap are never capped.
 */
import {
  type RuntimeProvider,
  resolveRuntimeProviderContext,
} from './providers/provider-ids.js';
import type { ContainerOutput, ToolDefinition } from './types.js';

// 128 (agent call, 2026-10-11, pending owner review; #1534): OpenAI rejects a
// longer `tools` array with 400 `array_above_max_length` on Chat Completions
// and Responses (Codex uses Responses). HybridAI forwards the OpenAI request
// schema and the upstream model is unknown here, so every HybridAI request is
// capped. Other providers document no cap; per-model caps for routers such as
// OpenRouter are deferred.
const TOOL_COUNT_LIMITS: Partial<Record<RuntimeProvider, number>> = {
  hybridai: 128,
  openai: 128,
  'openai-codex': 128,
};

export function resolveToolCountLimit(
  provider: RuntimeProvider | undefined,
  model: string,
): number | undefined {
  return TOOL_COUNT_LIMITS[resolveRuntimeProviderContext(provider, model)];
}

/**
 * `deferred`, plus every MCP tool in `tools` when the tools left exposed
 * (and `tool_catalog` itself) would exceed `limit`.
 */
export function deferMcpToolsOverLimit(
  tools: ToolDefinition[],
  deferred: string[],
  mcpToolNames: string[],
  limit: number | undefined,
): string[] {
  if (limit === undefined) return deferred;
  const deferredSet = new Set(deferred);
  const exposed = tools.filter((tool) => !deferredSet.has(tool.function.name));
  const catalog = exposed.length < tools.length ? 1 : 0;
  if (exposed.length + catalog <= limit) return deferred;
  const exposedNames = new Set(exposed.map((tool) => tool.function.name));
  const added = mcpToolNames.filter((name) => exposedNames.has(name));
  if (added.length === 0) return deferred;
  console.error(
    `[tools] ${tools.length} tools exceed the provider limit of ${limit}; deferring ${added.length} more MCP tools behind tool_catalog`,
  );
  return [...deferred, ...added];
}

/** The failed output for a request whose exposed tools exceed `limit`. */
export function toolCountLimitFailure(
  tools: ToolDefinition[],
  limit: number | undefined,
  provider: RuntimeProvider | undefined,
  model: string,
): ContainerOutput | null {
  if (limit === undefined || tools.length <= limit) return null;
  const error = `Too many tools for ${resolveRuntimeProviderContext(provider, model)} model ${model}: ${tools.length} > ${limit}, even with MCP tools deferred behind tool_catalog. Disable an MCP server or plugin, or restrict this agent's tools.`;
  console.error(`[tools] ${error}`);
  return { status: 'error', result: null, toolsUsed: [], error };
}
