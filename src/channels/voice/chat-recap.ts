/**
 * Chat recap for the realtime voice front: a bounded plain-text digest of the
 * text conversation a voice session was started from, so the realtime model
 * does not begin a call blank.
 *
 * Pure: no database access and no logging. The result never exceeds
 * `VOICE_CHAT_RECAP_MAX_CHARS`, and trimming always drops the oldest messages
 * and keeps the newest. The text is untrusted conversation content; framing it
 * as background (not instructions) is `buildRealtimeInstructions`' job.
 *
 * NOT the consulted agent's history: that turn loads the full session itself
 * in `gateway-chat-service.ts`. This only orients the voice front.
 */
import { isSilentReply } from '../../agent/silent-reply.js';
import { trimSessionPreviewText } from '../../session/session-preview.js';
import type { StoredMessage } from '../../types/session.js';

// 12 messages / 300 chars each / 600-char summary / 2,400 total (feature
// brief, 2026-09-30): enough to resolve "so, what do you think?" while the
// realtime instructions stay small. Tuning deferred to live-call feedback.
export const VOICE_CHAT_RECAP_MAX_MESSAGES = 12;
const MESSAGE_MAX_CHARS = 300;
const SUMMARY_MAX_CHARS = 600;
export const VOICE_CHAT_RECAP_MAX_CHARS = 2_400;

const ROLE_LABELS = new Map([
  ['user', 'User'],
  ['assistant', 'Assistant'],
]);

export interface VoiceChatRecapInput {
  /** The session's compaction summary, when one exists. */
  summary?: string | null;
  /** Stored session messages, oldest first. */
  messages: ReadonlyArray<Pick<StoredMessage, 'role' | 'content'>>;
}

function recapLine(
  label: string,
  content: string | null | undefined,
  maxChars: number,
): string | null {
  // Collapsed, not voice-formatted: the model reads this, and the voice
  // formatter would split "9.600" into "9. 600" and drop links.
  const text = trimSessionPreviewText(content, maxChars);
  return text ? `${label}: ${text}` : null;
}

export function buildVoiceChatRecap(input: VoiceChatRecapInput): string | null {
  const summaryLine = recapLine(
    'Summary of the earlier conversation',
    input.summary,
    SUMMARY_MAX_CHARS,
  );
  const messageLines: string[] = [];
  for (const message of input.messages) {
    const label = ROLE_LABELS.get(message.role);
    if (!label || isSilentReply(message.content)) continue;
    const line = recapLine(label, message.content, MESSAGE_MAX_CHARS);
    if (line) messageLines.push(line);
  }

  // Fill from the newest message backwards and stop at the first one that no
  // longer fits, so the recap stays a gap-free tail of the conversation.
  let budget =
    VOICE_CHAT_RECAP_MAX_CHARS - (summaryLine ? summaryLine.length : 0);
  const kept: string[] = [];
  for (const line of messageLines
    .slice(-VOICE_CHAT_RECAP_MAX_MESSAGES)
    .reverse()) {
    const cost = line.length + (summaryLine || kept.length > 0 ? 1 : 0);
    if (cost > budget) break;
    kept.unshift(line);
    budget -= cost;
  }

  const lines = summaryLine ? [summaryLine, ...kept] : kept;
  return lines.length > 0 ? lines.join('\n') : null;
}
