export type ModelThinkingFormat = 'qwen';
export type ModelToolCallFormat = 'gemma';

export interface ModelBehavior {
  thinkingFormat?: ModelThinkingFormat;
  toolCallFormat?: ModelToolCallFormat;
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
