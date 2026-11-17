/**
 * Background child activity stays visible in the owning web conversation.
 * Stores tool previews with the existing message trace and signals a refresh;
 * unlike completion notifications, progress never rings or marks chat unread.
 */
import { logger } from '../logger.js';
import { storeDelegationProgress } from '../memory/delegation-progress.js';
import { memoryService } from '../memory/memory-service.js';
import { redactCredentialSecrets } from '../security/redact.js';
import { ActivityTraceBuilder } from '../types/activity-trace.js';
import type { ToolProgressEvent } from '../types/execution.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from './show-mode.js';
import { broadcastWebChatUpdate } from './web-notifications.js';

export function createDelegationWebProgress(params: {
  jobId: string;
  sessionId: string;
  agentId: string;
}) {
  const trace = new ActivityTraceBuilder();
  const startedAt = Date.now();
  let lastTitle = '';
  const showTools = sessionShowModeShowsTools(
    normalizeSessionShowMode(
      memoryService.getSessionById(params.sessionId)?.show_mode,
    ),
  );
  return {
    recordTool(event: ToolProgressEvent, title: string): void {
      if (!showTools) return;
      const preview = event.preview
        ? redactCredentialSecrets(event.preview, true)
        : undefined;
      const callId = JSON.stringify([event.sessionId, event.toolCallId]);
      if (event.phase === 'start') {
        if (title !== lastTitle) {
          trace.pushDraft(redactCredentialSecrets(title, true));
          lastTitle = title;
        }
        trace.startTool(event.toolName, preview, callId);
      } else {
        trace.finishTool(event.toolName, event.durationMs, preview, callId);
      }
    },
    update(text: string, running = true): void {
      try {
        if (
          storeDelegationProgress({
            ...params,
            text: showTools
              ? redactCredentialSecrets(text, true)
              : running
                ? 'Delegated work is running.'
                : 'Delegated work finished.',
            trace: trace.build(Date.now() - startedAt, running),
          })
        )
          broadcastWebChatUpdate(params.sessionId);
      } catch {
        // Display failures must never fail or retry work with side effects.
        logger.warn(
          { jobId: params.jobId },
          'Could not store delegation progress',
        );
      }
    },
  };
}
