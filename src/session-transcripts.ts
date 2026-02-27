import fs from 'fs';
import path from 'path';

import { agentWorkspaceDir, ensureAgentDirs } from './ipc.js';
import { logger } from './logger.js';

const TRANSCRIPTS_DIR_NAME = '.session-transcripts';

export interface TranscriptEntry {
  sessionId: string;
  channelId: string;
  role: string;
  userId: string;
  username: string | null;
  content: string;
  createdAt?: string;
}

function safeSessionFilename(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return normalized || 'session';
}

export function appendSessionTranscript(agentId: string, entry: TranscriptEntry): void {
  try {
    ensureAgentDirs(agentId);
    const workspace = agentWorkspaceDir(agentId);
    const transcriptDir = path.join(workspace, TRANSCRIPTS_DIR_NAME);
    fs.mkdirSync(transcriptDir, { recursive: true });

    const filePath = path.join(transcriptDir, `${safeSessionFilename(entry.sessionId)}.jsonl`);
    const row = {
      sessionId: entry.sessionId,
      channelId: entry.channelId,
      role: entry.role,
      userId: entry.userId,
      username: entry.username,
      content: entry.content,
      createdAt: entry.createdAt || new Date().toISOString(),
    };
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf-8');
  } catch (err) {
    logger.debug({ agentId, sessionId: entry.sessionId, err }, 'Failed to append session transcript');
  }
}
