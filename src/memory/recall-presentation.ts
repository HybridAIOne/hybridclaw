/**
 * Memory-recall presentation — the shared user-visible account of prompt-time
 * built-in memory access across gateway clients and channel transports.
 *
 * NOT the retrieval layer (`memory-service.ts` decides what is recalled); this
 * module only formats already-selected memories and never reads stored data.
 */

import type { MemoryAccess, MemoryCitation } from '../types/memory.js';

export const MEMORY_RECALL_ACTIVITY_TOOL_NAME = 'memory_recall';

const MEMORY_ACTIVITY_PREVIEW_MAX_CHARS = 220;

function memoryCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'memory' : 'memories'}`;
}

function compactMemoryContents(memories: MemoryCitation[]): string {
  const contents = memories
    .map((memory) => memory.content.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  if (contents.length <= MEMORY_ACTIVITY_PREVIEW_MAX_CHARS) return contents;
  return `${contents.slice(0, MEMORY_ACTIVITY_PREVIEW_MAX_CHARS - 1)}…`;
}

export function formatMemoryAccessSummary(access: MemoryAccess): string {
  const parts: string[] = [];
  if (access.semanticRecallAttempted) {
    parts.push(
      access.recalledMemories.length > 0
        ? `Recalled ${memoryCountLabel(access.recalledMemories.length)}`
        : 'No relevant memories recalled',
    );
  }
  if (access.summaryIncluded) parts.push('Session summary accessed');
  return parts.join(' · ') || 'Memory context accessed';
}

export function formatMemoryAccessActivityPreview(
  access: MemoryAccess,
): string {
  const summary = formatMemoryAccessSummary(access);
  const contents = compactMemoryContents(access.recalledMemories);
  return contents ? `${summary}: ${contents}` : summary;
}

export function formatMemoryAccessMarkdown(access: MemoryAccess): string {
  const lines = [`*Memory: ${formatMemoryAccessSummary(access)}*`];
  for (const memory of access.recalledMemories) {
    lines.push(
      `${memory.ref}: ${memory.content} (${Math.round(memory.confidence * 100)}%)`,
    );
  }
  return lines.join('\n');
}
