/**
 * Memory-flush evidence and excerpts: retry noise cannot crowd out instructions,
 * and a model's save claim never substitutes for an append found on disk.
 * This prepares maintenance input; it does not alter stored conversation history.
 */
import type { ContainerOutput } from '../types/container.js';
import type { StoredMessage } from '../types/session.js';

export function memoryFlushExcerpts(
  messages: StoredMessage[],
  maxMessages: number,
  maxChars: number,
): string[] {
  const failedRequests = new Set<string>();
  const entries: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const content = message.content.replace(/\r/g, '').trim();
    const next = messages[index + 1];
    // This is the gateway's error record, not a classification of user prose.
    const failed =
      message.role === 'user' &&
      next?.role === 'assistant' &&
      next.content.startsWith(
        '[This turn ended with an error before a reply was produced: ',
      );
    if (failed) {
      if (!failedRequests.has(content)) entries.push(`[USER] ${content}`);
      failedRequests.add(content);
      // Keep recorded tool effects, even when the reply itself failed.
      const effects = next.content.slice(next.content.indexOf('\n') + 1);
      if (next.content.includes('\n')) entries.push(`[ASSISTANT] ${effects}`);
      index += 1;
    } else if (content) {
      entries.push(`[${message.role.toUpperCase()}] ${content}`);
    }
  }

  const excerpts: string[] = [];
  let batch: string[] = [];
  let size = 0;
  const flush = () => {
    if (batch.length) excerpts.push(batch.join('\n\n'));
    batch = [];
    size = 0;
  };
  for (const entry of entries) {
    if (entry.length > maxChars) {
      flush();
      // Only oversized records are split; every character reaches a flush.
      for (let offset = 0; offset < entry.length; ) {
        let end = Math.min(offset + maxChars, entry.length);
        if (end < entry.length && /[\uD800-\uDBFF]/.test(entry[end - 1]))
          end -= 1;
        excerpts.push(entry.slice(offset, end));
        offset = end;
      }
      continue;
    }
    const separator = batch.length ? 2 : 0;
    if (
      batch.length >= maxMessages ||
      size + separator + entry.length > maxChars
    )
      flush();
    size += (batch.length ? 2 : 0) + entry.length;
    batch.push(entry);
  }
  flush();
  return excerpts;
}

export function verifiedMemoryFlush(
  output: ContainerOutput,
  relativePath: string,
  before: string,
  after: string,
): boolean {
  if (output.status !== 'success') return false;
  const memoryTools = (output.toolExecutions ?? []).filter(
    (tool) => tool.name === 'memory',
  );
  if (output.result?.trim() === 'MEMORY_FLUSH_SKIPPED') {
    return (
      before === after &&
      memoryTools.every((tool) => {
        if (tool.isError || tool.blocked) return false;
        try {
          return ['read', 'list', 'search'].includes(
            JSON.parse(tool.arguments).action ?? 'read',
          );
        } catch {
          return false;
        }
      })
    );
  }
  const previous = before.trimEnd();
  if (after === before || !after.startsWith(previous)) return false;
  const added = after.slice(previous.length);
  let appended = false;
  for (const tool of memoryTools) {
    if (tool.isError || tool.blocked) return false;
    try {
      const args = JSON.parse(tool.arguments);
      const action = args.action?.trim().toLowerCase() ?? 'read';
      if (['read', 'list', 'search'].includes(action)) continue;
      const content =
        typeof args.content === 'string' ? args.content.trim() : '';
      if (
        action !== 'append' ||
        !content ||
        tool.result !== `Appended ${content.length} chars to ${relativePath}` ||
        !(
          added.includes(`\n\n${content}\n`) ||
          (!previous && added.startsWith(`${content}\n`))
        )
      )
        return false;
      appended = true;
    } catch {
      return false;
    }
  }
  return appended;
}
