export type ModelThinkingFormat = 'qwen';

export interface ModelBehavior {
  thinkingFormat?: ModelThinkingFormat;
}

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
