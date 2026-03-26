import fs from 'node:fs';
import path from 'node:path';

import { agentWorkspaceDir, ensureAgentDirs } from '../infra/ipc.js';
import { logger } from '../logger.js';
import type { StoredMessage } from '../types/session.js';

const SESSION_EXPORTS_DIR_NAME = '.session-exports';

interface ExportedMessageRow {
  type: 'message';
  section: 'full' | 'compacted' | 'retained';
  sessionId: string;
  channelId: string | null;
  id: number;
  role: string;
  userId: string;
  username: string | null;
  content: string;
  createdAt: string;
}

function safeFilePart(raw: string): string {
  const normalized = raw.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

function compactText(text: string, maxChars = 4_000): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function exportBaseDir(agentId: string, sessionId: string): string {
  ensureAgentDirs(agentId);
  return path.join(
    agentWorkspaceDir(agentId),
    SESSION_EXPORTS_DIR_NAME,
    safeFilePart(sessionId),
  );
}

function exportFilePath(baseDir: string, reason: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${stamp}-${safeFilePart(reason)}.jsonl`;
  return path.join(baseDir, filename);
}

function writeJsonlFile(filePath: string, rows: unknown[]): boolean {
  try {
    const lines = rows.map((row) => JSON.stringify(row)).join('\n');
    fs.writeFileSync(filePath, `${lines}\n`, 'utf8');
    return true;
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to write session export JSONL');
    return false;
  }
}

export function exportSessionSnapshotJsonl(params: {
  agentId: string;
  sessionId: string;
  channelId?: string | null;
  summary?: string | null;
  messages: StoredMessage[];
  reason: string;
}): { path: string; lineCount: number } | null {
  const agentId = params.agentId.trim();
  const sessionId = params.sessionId.trim();
  if (!agentId || !sessionId) return null;
  try {
    const baseDir = exportBaseDir(agentId, sessionId);
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = exportFilePath(baseDir, params.reason);
    const now = new Date().toISOString();
    const rows: unknown[] = [
      {
        type: 'meta',
        reason: params.reason,
        exportedAt: now,
        agentId,
        sessionId,
        channelId: params.channelId || null,
        messageCount: params.messages.length,
        hasSummary: Boolean((params.summary || '').trim()),
      },
    ];
    const summary = (params.summary || '').trim();
    if (summary) {
      rows.push({
        type: 'summary',
        sessionId,
        content: compactText(summary, 12_000),
      });
    }
    rows.push(
      ...params.messages.map<ExportedMessageRow>((message) => ({
        type: 'message',
        section: 'full',
        sessionId,
        channelId: params.channelId || null,
        id: message.id,
        role: message.role,
        userId: message.user_id,
        username: message.username,
        content: message.content,
        createdAt: message.created_at,
      })),
    );
    if (!writeJsonlFile(filePath, rows)) return null;
    return { path: filePath, lineCount: rows.length };
  } catch (err) {
    logger.warn(
      { agentId, sessionId, err },
      'Failed to export session snapshot',
    );
    return null;
  }
}

export function exportCompactedSessionJsonl(params: {
  agentId: string;
  sessionId: string;
  channelId: string;
  summary: string;
  compactedMessages: StoredMessage[];
  retainedMessages: StoredMessage[];
  deletedCount: number;
  cutoffId: number;
}): { path: string; lineCount: number } | null {
  const agentId = params.agentId.trim();
  const sessionId = params.sessionId.trim();
  if (!agentId || !sessionId) return null;
  try {
    const baseDir = exportBaseDir(agentId, sessionId);
    fs.mkdirSync(baseDir, { recursive: true });
    const filePath = exportFilePath(baseDir, 'compaction');
    const exportedAt = new Date().toISOString();
    const rows: unknown[] = [
      {
        type: 'meta',
        reason: 'compaction',
        exportedAt,
        agentId,
        sessionId,
        channelId: params.channelId,
        cutoffId: params.cutoffId,
        deletedCount: params.deletedCount,
        compactedMessageCount: params.compactedMessages.length,
        retainedMessageCount: params.retainedMessages.length,
      },
      {
        type: 'summary',
        sessionId,
        content: compactText(params.summary, 12_000),
      },
    ];

    rows.push(
      ...params.compactedMessages.map<ExportedMessageRow>((message) => ({
        type: 'message',
        section: 'compacted',
        sessionId,
        channelId: params.channelId,
        id: message.id,
        role: message.role,
        userId: message.user_id,
        username: message.username,
        content: message.content,
        createdAt: message.created_at,
      })),
    );
    rows.push(
      ...params.retainedMessages.map<ExportedMessageRow>((message) => ({
        type: 'message',
        section: 'retained',
        sessionId,
        channelId: params.channelId,
        id: message.id,
        role: message.role,
        userId: message.user_id,
        username: message.username,
        content: message.content,
        createdAt: message.created_at,
      })),
    );
    if (!writeJsonlFile(filePath, rows)) return null;
    return { path: filePath, lineCount: rows.length };
  } catch (err) {
    logger.warn(
      { agentId, sessionId, err },
      'Failed to export compacted session JSONL',
    );
    return null;
  }
}
