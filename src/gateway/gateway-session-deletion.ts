/**
 * Gateway session deletion awaits plugin finalization while history still exists.
 * Unlike the database row deletion, this owns runtime and notification cleanup;
 * callers remain responsible for authorization and selecting sessions to delete.
 * A dry run's throwaway session is discarded without plugin finalization (no
 * plugin saw it) and keeps its usage and audit records.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { DATA_DIR } from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { deleteArchives } from '../memory/compaction-archive.js';
import { withMemoryDatabase } from '../memory/database.js';
import { deleteSessionData, sessionHasUserMessages } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { ensurePluginManagerInitialized } from '../plugins/plugin-manager.js';
import { scopeWorkspaceDir } from '../scopes/scope-paths.js';
import { interruptGatewaySessionExecution } from './gateway-request-runtime.js';
import type { GatewayAdminDeleteSessionResult } from './gateway-types.js';
import { deleteWebNotificationSession } from './web-notification-store.js';

export async function deleteGatewayAdminSession(
  sessionId: string,
  options?: { onlyWithoutUserMessages?: boolean },
): Promise<GatewayAdminDeleteSessionResult> {
  const skippedResult: GatewayAdminDeleteSessionResult = {
    deleted: false,
    sessionId,
    skippedReason: 'has_user_messages',
    deletedMessages: 0,
    deletedTasks: 0,
    deletedSemanticMemories: 0,
    deletedUsageEvents: 0,
    deletedAuditEntries: 0,
    deletedStructuredAuditEntries: 0,
    deletedApprovalEntries: 0,
  };
  if (options?.onlyWithoutUserMessages && sessionHasUserMessages(sessionId)) {
    return skippedResult;
  }
  const session = memoryService.getSessionById(sessionId);
  const resolvedSessionId = session?.id || sessionId;
  interruptGatewaySessionExecution(resolvedSessionId);
  if (session) {
    try {
      const manager = await ensurePluginManagerInitialized();
      const agentId = session.agent_id || DEFAULT_AGENT_ID;
      await manager.notifySessionEnd({
        sessionId: session.id,
        userId:
          manager.getSessionUserId(session.id) ||
          memoryService
            .getRecentMessages(session.id)
            .reverse()
            .find((message) => message.role === 'user')?.user_id ||
          '',
        agentId,
        channelId: session.channel_id,
        workspacePath:
          manager.getSessionWorkspaceRoot(session.id) ||
          agentWorkspaceDir(agentId),
      });
    } catch (err) {
      logger.warn(
        { sessionId: session.id, err },
        'Session-end plugin notification failed; proceeding with deletion',
      );
    }
  }
  if (
    options?.onlyWithoutUserMessages &&
    sessionHasUserMessages(resolvedSessionId)
  ) {
    return skippedResult;
  }
  const result = deleteSessionData(resolvedSessionId);
  deleteWebNotificationSession(resolvedSessionId);
  return result;
}

/**
 * Removes the sessions a dry-run turn ran in, by session key or row id: rows
 * and files. Usage and audit records stay, so the turn is still accounted for.
 */
export function discardDryRunSessions(
  sessionKeys: readonly string[],
  agentId: string,
): void {
  const rowIds = withMemoryDatabase((db) =>
    db.transaction(() =>
      sessionKeys.flatMap((key) => {
        const rows = db
          .prepare('SELECT id FROM sessions WHERE id = ? OR session_key = ?')
          .all(key, key) as Array<{ id: string }>;
        for (const { id } of rows) {
          db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
          db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        }
        return rows.map((row) => row.id);
      }),
    )(),
  );
  for (const sessionId of new Set([...sessionKeys, ...rowIds])) {
    removeSessionFiles(sessionId, agentId, null);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
}

/** What a session leaves outside the database, by session row id. */
export function removeSessionFiles(
  sessionId: string,
  agent: string,
  scope: string | null,
): void {
  // A scoped chat keeps its transcript and tool results in its scope.
  const workspace = scope
    ? scopeWorkspaceDir(agent, scope)
    : agentWorkspaceDir(agent);
  const safe = safeName(sessionId);
  deleteArchives(sessionId);
  for (const target of [
    path.join(DATA_DIR, 'sessions', safe),
    path.join(workspace, '.session-transcripts', `${safe}.jsonl`),
    path.join(workspace, '.tool-results', safe),
    path.join(workspace, '.session-exports', safe),
    path.join(
      workspace,
      '.hybridclaw-runtime',
      'sessions',
      createHash('sha256').update(sessionId).digest('hex').slice(0, 32),
    ),
  ]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}
