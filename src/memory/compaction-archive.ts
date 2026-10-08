import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { estimateTokenCountFromMessages } from '../session/token-efficiency.js';
import type { ChatMessage } from '../types/api.js';
import type { ArchiveEntry } from '../types/memory.js';
import type { StoredMessage } from '../types/session.js';

const DEFAULT_ARCHIVE_ROOT = path.join(DATA_DIR, 'compaction-archives');

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

function toChatMessage(message: StoredMessage): ChatMessage {
  const role =
    message.role === 'system' ||
    message.role === 'user' ||
    message.role === 'assistant' ||
    message.role === 'tool'
      ? message.role
      : 'user';
  return {
    role,
    content: message.content,
  };
}

function resolveArchiveRoot(baseDir?: string): string {
  const candidate = (baseDir || '').trim();
  return candidate || DEFAULT_ARCHIVE_ROOT;
}

export function deleteArchives(sessionId: string): void {
  fs.rmSync(path.join(DEFAULT_ARCHIVE_ROOT, safeFilePart(sessionId)), {
    recursive: true,
    force: true,
  });
}

/** Moves a session's archives to a new session id; a no-op without any. */
export function renameArchives(
  fromSessionId: string,
  toSessionId: string,
): void {
  const source = path.join(DEFAULT_ARCHIVE_ROOT, safeFilePart(fromSessionId));
  if (!fs.existsSync(source)) return;
  fs.renameSync(
    source,
    path.join(DEFAULT_ARCHIVE_ROOT, safeFilePart(toSessionId)),
  );
}

export function archiveTranscript(params: {
  sessionId: string;
  messages: StoredMessage[];
  baseDir?: string;
}): ArchiveEntry {
  const archivedAt = new Date().toISOString();
  const archiveRoot = resolveArchiveRoot(params.baseDir);
  const sessionDir = path.join(archiveRoot, safeFilePart(params.sessionId));
  const stamp = archivedAt.replace(/[:.]/g, '-');
  const filePath = path.join(sessionDir, `${stamp}.json`);
  const estimatedTokens = estimateTokenCountFromMessages(
    params.messages.map(toChatMessage),
  );

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        version: 1,
        archivedAt,
        sessionId: params.sessionId,
        messageCount: params.messages.length,
        estimatedTokens,
        messages: params.messages,
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    sessionId: params.sessionId,
    path: filePath,
    archivedAt,
    messageCount: params.messages.length,
    estimatedTokens,
  };
}
