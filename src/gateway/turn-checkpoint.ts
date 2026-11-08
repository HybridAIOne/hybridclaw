/**
 * An unfinished turn already has conversation rows before worker dispatch.
 * Final storage replaces them atomically; recovery keeps their evidence and
 * never dispatches calls. Durable per-run receipts make repeated finalization
 * return the same message IDs, including after recovery or gateway restart.
 * Unlike audit, these rows are future model context.
 */
import { readTurnRecovery } from '../../container/shared/turn-checkpoint.js';
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
const finalizedKey = (runId: string) => `gateway.turn-finalized.${runId}`;
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
      if (getMemoryValue(opts.sessionId, finalizedKey(opts.runId)))
        throw new Error('A finalized run cannot be dispatched again.');
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
  const recovery = readTurnRecovery(
    pending.workspacePath,
    pending.workerSessionId,
    pending.runId,
    CONTAINER_MAX_OUTPUT_SIZE,
  );
  if (recovery.kind === 'recovered') {
    history = JSON.stringify(
      sanitizeToolHistory(recovery.evidence.toolHistory),
    );
    content = redactCredentialSecrets(recovery.evidence.error);
  } else {
    content += ` Worker recovery refused (${recovery.reason}); automatic replay is refused.`;
  }
  withMemoryDatabase((database) =>
    database.transaction(() => {
      database
        .prepare(
          'UPDATE messages SET content = ?, tool_history_json = ? WHERE id = ? AND session_id = ?',
        )
        .run(content, history, pending.assistantMessageId, sessionId);
      setMemoryValue(sessionId, finalizedKey(pending.runId), {
        value: {
          userMessageId: pending.userMessageId,
          assistantMessageId: pending.assistantMessageId,
        },
      });
      deleteMemoryValue(sessionId, CHECKPOINT_KEY);
    })(),
  );
}

type StoredTurn = ReturnType<typeof memoryService.storeTurn>;

/** Replace provisional rows and the pending marker in the same SQLite commit. */
export function finishTurnCheckpoint(
  sessionId: string,
  runId: string,
  store: () => StoredTurn,
): { value: StoredTurn; stored: boolean } {
  return withMemoryDatabase((database) =>
    database.transaction(() => {
      const receipt = getMemoryValue(sessionId, finalizedKey(runId)) as {
        value: StoredTurn;
      } | null;
      if (receipt) return { value: receipt.value, stored: false };
      const pending = getMemoryValue(
        sessionId,
        CHECKPOINT_KEY,
      ) as PendingTurn | null;
      if (pending && pending.runId !== runId)
        throw new Error('Finalization run does not match the pending turn.');
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
      const value = store();
      setMemoryValue(sessionId, finalizedKey(runId), { value });
      return { value, stored: true };
    })(),
  );
}
