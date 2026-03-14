const ALWAYS_PARALLEL_TOOL_NAMES = new Set([
  'read',
  'glob',
  'grep',
  'session_search',
  'vision_analyze',
  'image',
]);

const READ_ONLY_MESSAGE_ACTIONS = new Set([
  'read',
  'member-info',
  'channel-info',
]);

export const MAX_PARALLEL_TOOL_CALLS = 8;

function parseToolArgs(argsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function getToolExecutionMode(
  toolName: string,
  argsJson: string,
): 'parallel' | 'sequential' {
  const normalizedToolName = String(toolName || '')
    .trim()
    .toLowerCase();
  if (ALWAYS_PARALLEL_TOOL_NAMES.has(normalizedToolName)) {
    return 'parallel';
  }

  if (normalizedToolName === 'message') {
    const args = parseToolArgs(argsJson);
    const action = String(args?.action || '')
      .trim()
      .toLowerCase();
    if (READ_ONLY_MESSAGE_ACTIONS.has(action)) {
      return 'parallel';
    }
  }

  return 'sequential';
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
