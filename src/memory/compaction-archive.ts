import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config/config.js';
import { logger } from '../logger.js';
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

export function listArchives(
  sessionId: string,
  baseDir?: string,
): ArchiveEntry[] {
  const archiveRoot = resolveArchiveRoot(baseDir);
  const sessionDir = path.join(archiveRoot, safeFilePart(sessionId));
  if (!fs.existsSync(sessionDir)) return [];

  const entries: ArchiveEntry[] = [];
  for (const name of fs.readdirSync(sessionDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(sessionDir, name);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ArchiveEntry> & {
        archivedAt?: unknown;
        messageCount?: unknown;
        estimatedTokens?: unknown;
      };
      entries.push({
        sessionId,
        path: filePath,
        archivedAt:
          typeof parsed.archivedAt === 'string'
            ? parsed.archivedAt
            : new Date(0).toISOString(),
        messageCount:
          typeof parsed.messageCount === 'number' ? parsed.messageCount : 0,
        estimatedTokens:
          typeof parsed.estimatedTokens === 'number'
            ? parsed.estimatedTokens
            : 0,
      });
    } catch (err) {
      logger.warn({ filePath, err }, 'Failed to read compaction archive');
    }
  }

  return entries.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}
