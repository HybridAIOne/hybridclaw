/**
 * The one reading of `ChatMessage` content as plain text: non-empty text parts
 * joined with a newline. Media parts are dropped unless the caller asks for
 * `[image]`/`[audio]` placeholders. Callers trim when they need to.
 *
 * NOT `response-text.ts`, which reads untyped provider payloads and trims each
 * part.
 */
import type { ChatMessageContent } from '@hybridclaw/contracts/agent-io';

export function chatContentText(
  content: ChatMessageContent | undefined,
  options: { mediaPlaceholders?: boolean } = {},
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (part?.type === 'text') {
      if (part.text) chunks.push(part.text);
      continue;
    }
    if (!options.mediaPlaceholders) continue;
    if (part?.type === 'image_url' && part.image_url?.url) {
      chunks.push('[image]');
    } else if (part?.type === 'audio_url' && part.audio_url?.url) {
      chunks.push('[audio]');
    }
  }
  return chunks.join('\n');
}
