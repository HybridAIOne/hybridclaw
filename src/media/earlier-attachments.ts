/**
 * Earlier-attachments prompt: where files from previous turns of a session
 * live, and which of them media cleanup has already removed.
 *
 * Rebuilt every turn from the stored user rows and rendered into the per-turn
 * dynamic context, never written back into history, so stored turns stay
 * byte-stable for prompt caching and an expired file reads "no longer
 * available" instead of handing the model a stale path.
 *
 * NOT the current turn's `[MediaContext]` block (`buildMediaPromptContext`):
 * history is read before the current turn is stored, so this turn's uploads
 * never appear here.
 */
import {
  type MessageMediaItem,
  parseMessageMedia,
} from '../memory/messages.js';
import type { StoredMessage } from '../types/session.js';
import { createMediaHostPathResolver } from './media-host-path.js';

// 8 (agent call, 2026-09-26): covers a multi-file upload plus a few follow-up
// uploads while bounding what every later turn pays; older ones are omitted.
const MAX_EARLIER_ATTACHMENTS = 8;

export async function buildEarlierAttachmentsPrompt(params: {
  /** Stored session rows, newest first, as `getConversationHistory` returns. */
  history: readonly Pick<StoredMessage, 'role' | 'media_json'>[];
  workspaceRoot: string;
}): Promise<string> {
  const attachments = new Map<string, MessageMediaItem>();
  for (const message of params.history) {
    if (attachments.size >= MAX_EARLIER_ATTACHMENTS) break;
    if (message.role !== 'user') continue;
    for (const item of parseMessageMedia(message.media_json)) {
      if (attachments.size >= MAX_EARLIER_ATTACHMENTS) break;
      if (!attachments.has(item.path)) attachments.set(item.path, item);
    }
  }
  if (attachments.size === 0) return '';

  const resolveHostPath = createMediaHostPathResolver(params.workspaceRoot);
  // JSON keeps a user-chosen filename inside one quoted value, so it cannot
  // add lines or headings to the surrounding context.
  const entries = await Promise.all(
    [...attachments.values()].map(async (item) =>
      JSON.stringify({
        filename: item.filename,
        mime: item.mimeType || 'unknown',
        size: item.sizeBytes,
        ...((await resolveHostPath(item.path))
          ? { status: 'available', path: item.path }
          : { status: 'no longer available' }),
      }),
    ),
  );
  return [
    '## Earlier Attachments',
    'Files the user attached in earlier turns of this session, newest first, one JSON object per line. When the user refers to one of them, use its `path` directly (for example with `vision_analyze` or `read`) instead of asking for it again.',
    'An entry with status "no longer available" can no longer be read, usually because media cleanup removed it: do not reuse a path for it from earlier messages or tool calls, do not guess its contents, and do not create a placeholder file; ask the user to attach it again.',
    ...entries,
  ].join('\n');
}
