/**
 * Model behavior flags (`thinkingFormat` for local backends and
 * `adaptiveThinking` from provider discovery), normalized the same way by the
 * gateway and the agent's provider adapters. Unknown flags are dropped, never
 * passed through.
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
  if (behavior.adaptiveThinking === true) {
    normalized.adaptiveThinking = true;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function stripAdaptiveThinkingBehavior(
  behavior: ModelBehavior | undefined,
): ModelBehavior | undefined {
  if (!behavior) return undefined;
  return normalizeModelBehavior(
    behavior.thinkingFormat ? { thinkingFormat: behavior.thinkingFormat } : {},
  );
}

export function resolveModelBehavior(params: {
  model?: string;
  configured?: ModelBehavior;
}): ModelBehavior | undefined {
  void params.model;
  return normalizeModelBehavior(params.configured);
}
