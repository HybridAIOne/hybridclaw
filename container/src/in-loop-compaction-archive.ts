/**
 * Keeps complete pre-compaction messages in the persistent session state dir.
 * Unlike gateway transcript archives, these cover regions replaced inside a
 * running tool loop. A failed write must prevent replacement, never lose evidence.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACE_ROOT } from './runtime-paths.js';
import { ensureSessionStateDir, sessionStatePath } from './session-state.js';
import type { ChatMessage } from './types.js';

export interface InLoopCompactionArchive {
  path: string;
  write: (messages: ChatMessage[]) => void;
}

export function createInLoopCompactionArchive(
  sessionId: string,
): InLoopCompactionArchive {
  const filePath = sessionStatePath(
    sessionId,
    `in-loop-compactions/${randomUUID()}.json`,
  );
  return {
    path: path.relative(WORKSPACE_ROOT, filePath).replaceAll(path.sep, '/'),
    write: (messages) => {
      ensureSessionStateDir(filePath);
      fs.writeFileSync(filePath, JSON.stringify({ version: 1, messages }), {
        mode: 0o600,
        flag: 'wx',
      });
    },
  };
}
