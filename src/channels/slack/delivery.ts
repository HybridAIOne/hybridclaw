import { SLACK_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';

export function buildResponseText(text: string, toolsUsed?: string[]): string {
  let body = text;
  if (toolsUsed && toolsUsed.length > 0) {
    body = `${body}\n_Tools: ${toolsUsed.join(', ')}_`;
  }
  return body;
}

export function prepareSlackTextChunks(text: string): string[] {
  const chunks = chunkMessage(text, {
    maxChars: Math.max(200, Math.min(40_000, SLACK_TEXT_CHUNK_LIMIT)),
    maxLines: 200,
  })
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chunks.length > 0 ? chunks : ['(no content)'];
}
