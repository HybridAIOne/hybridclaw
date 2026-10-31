/**
 * An unfinished turn already has conversation rows before worker dispatch.
 * Final storage replaces them atomically; recovery keeps their evidence and
 * never dispatches calls. Unlike audit, these rows are future model context.
 */
import {
  checkpointOutput,
  readTurnCheckpoint,
} from '../../container/shared/turn-checkpoint.js';
import type { ExecutorRequest } from '../agent/executor-types.js';
import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_SANDBOX_MODE,
} from '../config/config.js';
import { hostWorkspaceStateRoot } from '../infra/host-workspace.js';
import { withMemoryDatabase } from '../memory/database.js';
import {
  deleteMemoryValue,
  getMemoryValue,
  setMemoryValue,
} from '../memory/kv.js';
import { memoryService } from '../memory/memory-service.js';
import { redactCredentialSecrets } from '../security/redact.js';
import { sanitizeToolHistory } from '../session/tool-history.js';
import type { MediaContextItem } from '../types/container.js';

const CHECKPOINT_KEY = 'gateway.turn-checkpoint';
const INTERRUPTED =
  'This turn did not finish. Tool side effects may have occurred; verify external state before retrying. No actions have been automatically repeated.';

interface PendingTurn {
  runId: string;
  workspacePath: string;
  workerSessionId: string;
  userMessageId: number;
  assistantMessageId: number;
}

export function beginTurnCheckpoint(
  opts: {
    sessionId: string;
    agentId: string;
    userId: string;
    username: string | null;
    userContent: string;
    userMedia?: readonly MediaContextItem[];
    userDynamicContext?: string | null;
    userSource?: string | null;
    workspacePath: string;
    workerSessionId: string;
    runId: string;
  } & Pick<ExecutorRequest, 'executorModeOverride' | 'runtimeScope'>,
): void {
  withMemoryDatabase((database) =>
    database.transaction(() => {
      if (getMemoryValue(opts.sessionId, CHECKPOINT_KEY))
        throw new Error(
          'An unfinished turn must be recovered before dispatch.',
        );
      const userMessageId = memoryService.storeMessage({
        sessionId: opts.sessionId,
        userId: opts.userId,
        username: opts.username,
        role: 'user',
        content: opts.userContent,
        media: opts.userMedia,
        dynamicContext: opts.userDynamicContext,
        source: opts.userSource,
      });
      const assistantMessageId = memoryService.storeMessage({
        sessionId: opts.sessionId,
        userId: 'assistant',
        username: null,
        agentId: opts.agentId,
        role: 'assistant',
        content: INTERRUPTED,
      });
      setMemoryValue(opts.sessionId, CHECKPOINT_KEY, {
        runId: opts.runId,
        workspacePath:
          (opts.executorModeOverride || CONTAINER_SANDBOX_MODE) === 'host'
            ? hostWorkspaceStateRoot(opts)
            : opts.workspacePath,
        workerSessionId: opts.workerSessionId,
        userMessageId,
        assistantMessageId,
      } satisfies PendingTurn);
    })(),
  );
}

/** Called inside the session queue, before building the next turn's context. */
export function recoverTurnCheckpoint(sessionId: string): void {
  const pending = getMemoryValue(
    sessionId,
    CHECKPOINT_KEY,
  ) as PendingTurn | null;
  if (!pending) return;
  let content = INTERRUPTED;
  let history: string | null = null;
  try {
    const saved = readTurnCheckpoint(
      pending.workspacePath,
      pending.workerSessionId,
      CONTAINER_MAX_OUTPUT_SIZE,
    );
    if (saved?.turnId === pending.runId) {
      const output = checkpointOutput(saved);
      history = JSON.stringify(sanitizeToolHistory(output.toolHistory));
      content = redactCredentialSecrets(output.error);
    }
  } catch {
    content +=
      ' The worker checkpoint is unreadable; automatic replay is refused.';
  }
  withMemoryDatabase((database) =>
    database.transaction(() => {
      database
        .prepare(
          'UPDATE messages SET content = ?, tool_history_json = ? WHERE id = ? AND session_id = ?',
        )
        .run(content, history, pending.assistantMessageId, sessionId);
      deleteMemoryValue(sessionId, CHECKPOINT_KEY);
    })(),
  );
}

/** Replace provisional rows and the pending marker in the same SQLite commit. */
export function finishTurnCheckpoint<T>(sessionId: string, store: () => T): T {
  return withMemoryDatabase((database) =>
    database.transaction(() => {
      const pending = getMemoryValue(
        sessionId,
        CHECKPOINT_KEY,
      ) as PendingTurn | null;
      if (pending) {
        const removed = database
          .prepare('DELETE FROM messages WHERE session_id = ? AND id IN (?, ?)')
          .run(
            sessionId,
            pending.userMessageId,
            pending.assistantMessageId,
          ).changes;
        database
          .prepare(
            'UPDATE sessions SET message_count = message_count - ? WHERE id = ?',
          )
          .run(removed, sessionId);
        deleteMemoryValue(sessionId, CHECKPOINT_KEY);
      }
      return store();
    })(),
  );
}
