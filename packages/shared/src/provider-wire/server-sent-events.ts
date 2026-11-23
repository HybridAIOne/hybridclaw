/**
 * Server-sent events decoder — the one parser for every SSE consumer: worker
 * providers, gateway model clients, the proxy agent, local benchmarks, and
 * the console.
 *
 * Follows the SSE field rules: multi-line `data:` fields join with `\n`, one
 * leading space is stripped, comments and unknown fields are ignored. A final
 * event that lacks its terminating blank line is still delivered, because
 * some servers close the stream right after the last `data:` line. Reading
 * and its deadlines belong to the caller, which passes its own `read`.
 */
export interface ServerSentEvent {
  event: string | null;
  data: string;
}

function drainServerSentEventBlocks(buffer: string): {
  blocks: string[];
  remainder: string;
} {
  const blocks = buffer.split(/\r?\n\r?\n/);
  return {
    blocks: blocks.slice(0, -1),
    remainder: blocks.at(-1) || '',
  };
}

function parseServerSentEventBlock(block: string): ServerSentEvent | null {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | null = null;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;

    const separatorIndex = rawLine.indexOf(':');
    const field =
      separatorIndex === -1 ? rawLine.trim() : rawLine.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ''
        : rawLine.slice(separatorIndex + 1).replace(/^ /, '');

    if (field === 'event') {
      event = value || null;
      continue;
    }

    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join('\n'),
  };
}

export async function* readServerSentEvents(
  read: () => Promise<{ done: boolean; value?: Uint8Array }>,
): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await read();
    buffer += decoder.decode(value, { stream: !done });
    const drained = drainServerSentEventBlocks(buffer);
    buffer = drained.remainder;
    for (const block of drained.blocks) {
      const event = parseServerSentEventBlock(block);
      if (event) yield event;
    }
    if (done) break;
  }
  const tail = parseServerSentEventBlock(buffer);
  if (tail) yield tail;
}
