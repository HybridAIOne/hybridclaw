export type ModelThinkingFormat = 'qwen';
export type ModelToolCallFormat = 'gemma';

export interface ModelBehavior {
  thinkingFormat?: ModelThinkingFormat;
  toolCallFormat?: ModelToolCallFormat;
}

function isGemmaModelName(model: string | undefined): boolean {
  const normalized = String(model || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized
    .split(/[^a-z0-9]+/i)
    .some((token) => /^gemma\d*$/.test(token));
}

export function normalizeModelBehavior(
  behavior: ModelBehavior | undefined,
): ModelBehavior | undefined {
  if (!behavior) return undefined;
  const normalized: ModelBehavior = {};
  if (behavior.thinkingFormat === 'qwen') {
    normalized.thinkingFormat = 'qwen';
  }
  if (behavior.toolCallFormat === 'gemma') {
    normalized.toolCallFormat = 'gemma';
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function inferModelBehaviorFromModelName(
  model: string | undefined,
): ModelBehavior | undefined {
  if (isGemmaModelName(model)) {
    return { toolCallFormat: 'gemma' };
  }
  return undefined;
}

export function resolveModelBehavior(params: {
  model?: string;
  configured?: ModelBehavior;
}): ModelBehavior | undefined {
  return normalizeModelBehavior({
    ...(inferModelBehaviorFromModelName(params.model) || {}),
    ...(params.configured || {}),
  });
}
