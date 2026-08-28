/**
 * Tool policy — the single answer to "which tools may this turn call".
 *
 * Two independent restrictions compose here and nowhere else: the runtime
 * denylist (`tools.disabled`) plus any caller-supplied block list, and the
 * per-agent allowlist (`agents.list[].tools`) intersected with the caller's
 * allowlist. An agent without a configured allowlist stays unrestricted; an
 * empty allowlist means no tools, never "all tools".
 *
 * NOT the approval policy (`.hybridclaw/policy.yaml` decides whether an
 * allowed call needs a human); this module only decides whether the tool is
 * offered to the model at all.
 */
import { resolveAgentConfig } from '../agents/agent-registry.js';
import {
  getRuntimeConfig,
  getRuntimeDisabledToolNames,
} from '../config/runtime-config.js';
import { normalizeTrimmedStringSet } from '../utils/normalized-strings.js';

export function mergeBlockedToolNames(params?: {
  explicit?: readonly string[] | null;
  runtimeDisabled?: Iterable<string>;
}): string[] | undefined {
  const explicit = Array.isArray(params?.explicit) ? params.explicit : [];
  const runtimeDisabled =
    params?.runtimeDisabled ?? getRuntimeDisabledToolNames(getRuntimeConfig());
  const merged = [
    ...normalizeTrimmedStringSet([...explicit, ...runtimeDisabled]),
  ];
  return merged.length > 0 ? merged : undefined;
}

/**
 * Intersect the caller's allowlist with the agent's configured tool
 * allowlist. Returns undefined when neither restricts the toolset.
 */
export function mergeAllowedToolNames(params: {
  agentId?: string | null;
  explicit?: readonly string[] | null;
}): string[] | undefined {
  const explicit = Array.isArray(params.explicit)
    ? [...normalizeTrimmedStringSet(params.explicit)]
    : null;
  const configured = resolveAgentConfig(params.agentId).tools;
  if (!Array.isArray(configured)) return explicit ?? undefined;
  const agentAllowed = [...normalizeTrimmedStringSet(configured)];
  if (!explicit) return agentAllowed;
  const explicitSet = new Set(explicit);
  return agentAllowed.filter((name) => explicitSet.has(name));
}
