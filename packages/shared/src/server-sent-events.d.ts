export interface ServerSentEvent {
  event: string | null;
  data: string;
}

export function drainServerSentEventBlocks(buffer: string): {
  blocks: string[];
  remainder: string;
};

export function parseServerSentEventBlock(
  block: string,
): ServerSentEvent | null;
