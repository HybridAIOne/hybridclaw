/**
 * Agent-local transcripts retain chat and full tool exchanges for retrieval.
 * They are searchable evidence, not instructions or the gateway audit trail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionTranscriptFilename } from '../../container/shared/tool-history.js';
import { agentWorkspaceDir, ensureAgentDirs } from '../infra/ipc.js';
import { logger } from '../logger.js';
import type { ChatMessage } from '../types/api.js';
import { sanitizeToolHistory } from './tool-history.js';

const TRANSCRIPTS_DIR_NAME = '.session-transcripts';

export interface TranscriptEntry {
  sessionId: string;
  channelId: string;
  role: string;
  userId: string;
  username: string | null;
  content: string;
  createdAt?: string;
  toolHistory?: ChatMessage[];
}

export function appendSessionTranscript(
  agentId: string,
  entry: TranscriptEntry,
): void {
  try {
    ensureAgentDirs(agentId);
    const workspace = agentWorkspaceDir(agentId);
    const transcriptDir = path.join(workspace, TRANSCRIPTS_DIR_NAME);
    fs.mkdirSync(transcriptDir, { recursive: true });
    if (fs.lstatSync(transcriptDir).isSymbolicLink()) {
      throw new Error('Session transcript directory must not be a symlink.');
    }

    const filePath = path.join(
      transcriptDir,
      sessionTranscriptFilename(entry.sessionId),
    );
    const row = {
      sessionId: entry.sessionId,
      channelId: entry.channelId,
      role: entry.role,
      userId: entry.userId,
      username: entry.username,
      content: entry.content,
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    const toolRows = entry.toolHistory?.length
      ? sanitizeToolHistory(entry.toolHistory).map((message) => ({
          ...row,
          role: message.role,
          content:
            message.role === 'assistant'
              ? [
                  message.content || '',
                  ...(message.tool_calls || []).map(
                    (call) =>
                      `${call.function.name} ${call.function.arguments} (tool_call_id=${call.id})`,
                  ),
                ].join('\n')
              : message.content,
          ...(message.tool_call_id
            ? { tool_call_id: message.tool_call_id }
            : {}),
        }))
      : [];
    const fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(
        fd,
        [...toolRows, row]
          .map((value) => `${JSON.stringify(value)}\n`)
          .join(''),
        'utf-8',
      );
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logger.debug(
      { agentId, sessionId: entry.sessionId, err },
      'Failed to append session transcript',
    );
  }
}
