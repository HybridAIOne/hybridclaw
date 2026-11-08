/**
 * Complete text of the latest nonempty user request for intent-sensitive reviews.
 * Unlike bounded status or approval-reply excerpts, it preserves trailing
 * constraints and layout. Other roles and non-text blocks are never user intent;
 * this selector neither interprets instructions nor grants tool permission.
 */
import { normalizeMessageContentToText } from './ralph.js';
import type { ChatMessage } from './types.js';

export function latestUserRequestText(
  messages: readonly ChatMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const text = normalizeMessageContentToText(messages[i].content).trim();
    if (text) return text;
  }
  return '';
}
