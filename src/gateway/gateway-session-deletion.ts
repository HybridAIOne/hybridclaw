/**
 * Gateway session deletion awaits plugin finalization while history still exists.
 * Unlike the database row deletion, this owns runtime and notification cleanup;
 * callers remain responsible for authorization and selecting sessions to delete.
 */
import { DEFAULT_AGENT_ID } from '../agents/agent-types.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { deleteSessionData, sessionHasUserMessages } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { ensurePluginManagerInitialized } from '../plugins/plugin-manager.js';
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
