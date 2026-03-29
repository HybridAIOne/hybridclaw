import { chunkMessage } from '../../memory/chunk.js';

function clampTextChunkLimit(limit: number): number {
  return Math.max(200, Math.min(4_000, Math.floor(limit)));
}

export function prepareIMessageTextChunks(
  text: string,
  textChunkLimit: number,
): string[] {
  const chunks = chunkMessage(text, {
    maxChars: clampTextChunkLimit(textChunkLimit),
    maxLines: 200,
  }).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : ['(no content)'];
}
