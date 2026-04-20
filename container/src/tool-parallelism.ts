// Hermes-style policy: run tool batches concurrently by default and reserve a
// small explicit denylist for interactive tools that must preserve turn order.
const NEVER_PARALLEL_TOOL_NAMES = new Set(['bash', 'clarify']);

export function getToolExecutionMode(
  toolName: string,
  _argsJson: string,
): 'parallel' | 'sequential' {
  const normalizedToolName = String(toolName || '')
    .trim()
    .toLowerCase();
  return NEVER_PARALLEL_TOOL_NAMES.has(normalizedToolName)
    ? 'sequential'
    : 'parallel';
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
