/**
 * Heartbeat — periodic poll so the agent can proactively check tasks,
 * maintain memory, and reach out when needed.
 */

import { runAgent } from '../agent/agent.js';
import { buildConversationContext } from '../agent/conversation.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { processSideEffects } from '../agent/side-effects.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import {
  emitToolExecutionAuditEvents,
  makeAuditRunId,
  recordAuditEvent,
} from '../audit/audit-events.js';
import { SYSTEM_CAPABILITIES } from '../channels/channel.js';
import { getChannel, registerChannel } from '../channels/channel-registry.js';
import {
  HEARTBEAT_CHANNEL,
  HEARTBEAT_ENABLED,
  HYBRIDAI_CHATBOT_ID,
} from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { getTasksForSession } from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import {
  modelRequiresChatbotId,
  resolveModelProvider,
} from '../providers/factory.js';
import { buildSessionContext } from '../session/session-context.js';
import { buildSessionKey } from '../session/session-key.js';
import { maybeCompactSession } from '../session/session-maintenance.js';
import { appendSessionTranscript } from '../session/session-transcripts.js';
import { runPeriodicSkillInspection } from '../skills/skills-inspection.js';
import {
  buildModelUsageAuditStats,
  recordModelUsageAuditEvent,
} from './model-usage.js';

const HEARTBEAT_PROMPT =
  '[Heartbeat poll] Check HEARTBEAT.md for periodic tasks. If nothing needs attention, reply HEARTBEAT_OK.';

const MAX_HEARTBEAT_HISTORY = 5;
const HEARTBEAT_ALLOWED_TOOLS = [
  'read',
  'write',
  'edit',
  'delete',
  'glob',
  'grep',
  'bash',
  'memory',
  'session_search',
  'web_search',
  'web_fetch',
  'web_extract',
  'message',
  'cron',
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_back',
  'browser_screenshot',
  'browser_pdf',
  'browser_vision',
  'vision_analyze',
  'image',
  'browser_get_images',
  'browser_console',
  'browser_network',
  'browser_close',
];

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function isHeartbeatOk(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[^a-z]/gi, '')
    .toUpperCase();
  return normalized === 'HEARTBEATOK' || normalized.startsWith('HEARTBEATOK');
}

export function startHeartbeat(
  agentId: string,
  interval: number,
  onMessage: (text: string) => void,
): void {
  if (!HEARTBEAT_ENABLED) {
    logger.info('Heartbeat disabled via HEARTBEAT_ENABLED=false');
    return;
  }

  logger.info({ interval }, 'Heartbeat started');
  registerChannel({
    kind: 'heartbeat',
    id: HEARTBEAT_CHANNEL || 'heartbeat',
    capabilities: SYSTEM_CAPABILITIES,
  });

  timer = setInterval(async () => {
    if (running) {
      logger.debug('Heartbeat skipped — previous still running');
      return;
    }
    if (!isWithinActiveHours()) {
      logger.debug(
        { activeHours: proactiveWindowLabel() },
        'Heartbeat skipped — outside active hours window',
      );
      return;
    }
    running = true;

    const sessionId = buildSessionKey(
      agentId,
      'heartbeat',
      'system',
      'default',
    );
    const channelId = 'heartbeat';
    const runId = makeAuditRunId('heartbeat');
    const startedAt = Date.now();
    let turnIndex = 1;

    try {
      const session = memoryService.getOrCreateSession(
        sessionId,
        null,
        channelId,
        agentId,
      );
      turnIndex = session.message_count + 1;

      const history = memoryService.getConversationHistory(
        sessionId,
        MAX_HEARTBEAT_HISTORY,
      );
      const memoryContext = memoryService.buildPromptMemoryContext({
        session,
        query: HEARTBEAT_PROMPT,
      });
      const resolvedRuntime = resolveAgentForRequest({
        agentId,
        session,
      });
      const model = resolvedRuntime.model;
      const chatbotId = modelRequiresChatbotId(model)
        ? resolvedRuntime.chatbotId || HYBRIDAI_CHATBOT_ID || agentId
        : resolvedRuntime.chatbotId;
      const resolvedAgentId = resolvedRuntime.agentId;
      const enableRag = session.enable_rag !== 0;
      const workspacePath = agentWorkspaceDir(resolvedAgentId);
      const sessionContext = buildSessionContext({
        source: {
          channelKind: 'heartbeat',
          chatId: channelId,
          chatType: 'system',
          userId: 'heartbeat',
          userName: 'heartbeat',
          guildId: null,
        },
        agentId: resolvedAgentId,
        sessionId: session.id,
        sessionKey: session.session_key,
      });
      const { messages } = buildConversationContext({
        agentId: resolvedAgentId,
        sessionSummary: memoryContext.promptSummary,
        history,
        runtimeInfo: {
          channel: getChannel('heartbeat'),
          chatbotId,
          model,
          defaultModel: model,
          channelType: 'heartbeat',
          channelId,
          guildId: null,
          sessionContext,
          workspacePath,
        },
        allowedTools: HEARTBEAT_ALLOWED_TOOLS,
      });
      messages.push({ role: 'user', content: HEARTBEAT_PROMPT });

      const provider = resolveModelProvider(model);
      const heartbeatChannelId = HEARTBEAT_CHANNEL || 'heartbeat';
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'session.start',
          userId: 'heartbeat',
          channel: heartbeatChannelId,
          cwd: workspacePath,
          model,
          source: 'heartbeat',
        },
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'turn.start',
          turnIndex,
          userInput: HEARTBEAT_PROMPT,
          source: 'heartbeat',
        },
      });

      const scheduledTasks = getTasksForSession(sessionId);
      const output = await runAgent({
        sessionId,
        messages,
        chatbotId,
        enableRag,
        model,
        agentId: resolvedAgentId,
        channelId: heartbeatChannelId,
        scheduledTasks,
        allowedTools: HEARTBEAT_ALLOWED_TOOLS,
      });
      emitToolExecutionAuditEvents({
        sessionId,
        runId,
        toolExecutions: output.toolExecutions || [],
      });
      const usage = buildModelUsageAuditStats({
        messages,
        resultText: output.result,
        toolCallCount: (output.toolExecutions || []).length,
        tokenUsage: output.tokenUsage,
      });
      recordModelUsageAuditEvent({
        sessionId,
        runId,
        provider,
        model,
        startedAt,
        usage,
      });
      try {
        await runPeriodicSkillInspection({
          agentId: resolvedAgentId,
        });
      } catch (error) {
        logger.warn(
          { agentId: resolvedAgentId, error },
          'Skill inspection failed',
        );
      }
      processSideEffects(output, sessionId, heartbeatChannelId);

      if (output.status === 'error') {
        logger.warn({ error: output.error }, 'Heartbeat agent error');
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'error',
            errorType: 'heartbeat',
            message: output.error || 'Heartbeat run failed',
            recoverable: true,
          },
        });
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'turn.end',
            turnIndex,
            finishReason: 'error',
          },
        });
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'session.end',
            reason: 'error',
            stats: {
              userMessages: 1,
              assistantMessages: 0,
              toolCalls: (output.toolExecutions || []).length,
              durationMs: Date.now() - startedAt,
            },
          },
        });
        return;
      }

      const result = (output.result || '').trim();

      if (isHeartbeatOk(result)) {
        logger.debug('Heartbeat: HEARTBEAT_OK — nothing to do');
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'turn.end',
            turnIndex,
            finishReason: 'heartbeat_ok',
          },
        });
        recordAuditEvent({
          sessionId,
          runId,
          event: {
            type: 'session.end',
            reason: 'normal',
            stats: {
              userMessages: 1,
              assistantMessages: 1,
              toolCalls: (output.toolExecutions || []).length,
              durationMs: Date.now() - startedAt,
            },
          },
        });
        return;
      }

      // Real content — persist and deliver
      memoryService.storeTurn({
        sessionId,
        user: {
          userId: 'heartbeat',
          username: 'heartbeat',
          content: HEARTBEAT_PROMPT,
        },
        assistant: {
          userId: 'assistant',
          username: null,
          content: result,
        },
      });
      appendSessionTranscript(resolvedAgentId, {
        sessionId,
        channelId: heartbeatChannelId,
        role: 'user',
        userId: 'heartbeat',
        username: 'heartbeat',
        content: HEARTBEAT_PROMPT,
      });
      appendSessionTranscript(resolvedAgentId, {
        sessionId,
        channelId: heartbeatChannelId,
        role: 'assistant',
        userId: 'assistant',
        username: null,
        content: result,
      });
      await maybeCompactSession({
        sessionId,
        agentId: resolvedAgentId,
        chatbotId,
        enableRag,
        model,
        channelId: heartbeatChannelId,
      });
      logger.info(
        { length: result.length },
        'Heartbeat: agent has something to say',
      );
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'completed',
        },
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'normal',
          stats: {
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: (output.toolExecutions || []).length,
            durationMs: Date.now() - startedAt,
          },
        },
      });
      onMessage(result);
    } catch (err) {
      logger.error({ err }, 'Heartbeat failed');
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'error',
          errorType: 'heartbeat',
          message: err instanceof Error ? err.message : String(err),
          recoverable: true,
        },
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'turn.end',
          turnIndex,
          finishReason: 'error',
        },
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'session.end',
          reason: 'error',
          stats: {
            userMessages: 1,
            assistantMessages: 0,
            toolCalls: 0,
            durationMs: Date.now() - startedAt,
          },
        },
      });
    } finally {
      running = false;
    }
  }, interval);
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Heartbeat stopped');
  }
}
