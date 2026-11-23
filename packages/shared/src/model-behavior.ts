/**
 * Model behavior flags for local backends (today only the qwen thinking
 * format), normalized the same way by the gateway's discovery and the agent's
 * provider adapters. Unknown flags are dropped, never passed through.
 */

import type { ModelBehavior } from '@hybridclaw/contracts/agent-io';

export function normalizeModelBehavior(
  behavior: ModelBehavior | undefined,
): ModelBehavior | undefined {
  if (!behavior) return undefined;
  const normalized: ModelBehavior = {};
  if (behavior.thinkingFormat === 'qwen') {
    normalized.thinkingFormat = 'qwen';
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function resolveModelBehavior(params: {
  model?: string;
  configured?: ModelBehavior;
}): ModelBehavior | undefined {
  void params.model;
  return normalizeModelBehavior(params.configured);
}
