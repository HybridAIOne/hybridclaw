// Hermes-style policy: run tool batches concurrently by default and reserve a
// small explicit denylist for interactive tools that must preserve turn order.
const NEVER_PARALLEL_TOOL_NAMES = new Set(['clarify']);

export const MAX_PARALLEL_TOOL_CALLS = 8;

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

export async function mapConcurrentInOrder<TItem, TResult>(
  items: readonly TItem[],
  worker: (item: TItem, index: number) => Promise<TResult>,
  maxConcurrency = MAX_PARALLEL_TOOL_CALLS,
): Promise<TResult[]> {
  if (items.length === 0) return [];

  const results = new Array<TResult>(items.length);
  const workerCount = Math.max(
    1,
    Math.min(Math.trunc(maxConcurrency) || 1, items.length),
  );
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}
