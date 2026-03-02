/**
 * Heartbeat — periodic poll so the agent can proactively check tasks,
 * maintain memory, and reach out when needed.
 */
import { HEARTBEAT_CHANNEL, HEARTBEAT_ENABLED, HYBRIDAI_CHATBOT_ID, HYBRIDAI_ENABLE_RAG, HYBRIDAI_MODEL } from './config.js';
import { runAgent } from './agent.js';
import { getConversationHistory, getOrCreateSession, getTasksForSession, storeMessage } from './db.js';
import { logger } from './logger.js';
import { processSideEffects } from './side-effects.js';
import { maybeCompactSession } from './session-maintenance.js';
import { appendSessionTranscript } from './session-transcripts.js';
import { buildConversationContext } from './conversation.js';
import { isWithinActiveHours, proactiveWindowLabel } from './proactive-policy.js';
import { emitToolExecutionAuditEvents, makeAuditRunId, recordAuditEvent } from './audit-events.js';

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
  'web_fetch',
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
  'browser_close',
];

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function isHeartbeatOk(text: string): boolean {
  const normalized = text.trim().replace(/[^a-z_]/gi, '').toUpperCase();
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

  timer = setInterval(async () => {
    if (running) {
      logger.debug('Heartbeat skipped — previous still running');
      return;
    }
    if (!isWithinActiveHours()) {
      logger.debug({ activeHours: proactiveWindowLabel() }, 'Heartbeat skipped — outside active hours window');
      return;
    }
    running = true;

    const sessionId = `heartbeat:${agentId}`;
    const channelId = 'heartbeat';
    const runId = makeAuditRunId('heartbeat');
    const startedAt = Date.now();
    let turnIndex = 1;

    try {
      const session = getOrCreateSession(sessionId, null, channelId);
      turnIndex = session.message_count + 1;

      const history = getConversationHistory(sessionId, MAX_HEARTBEAT_HISTORY);
      const { messages } = buildConversationContext({
        agentId,
        sessionSummary: session.session_summary,
        history,
      });
      messages.push({ role: 'user', content: HEARTBEAT_PROMPT });

      const chatbotId = HYBRIDAI_CHATBOT_ID || agentId;
      const heartbeatChannelId = HEARTBEAT_CHANNEL || 'heartbeat';
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'session.start',
          userId: 'heartbeat',
          channel: heartbeatChannelId,
          cwd: process.cwd(),
          model: HYBRIDAI_MODEL,
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
      const output = await runAgent(
        sessionId,
        messages,
        chatbotId,
        HYBRIDAI_ENABLE_RAG,
        HYBRIDAI_MODEL,
        agentId,
        heartbeatChannelId,
        scheduledTasks,
        HEARTBEAT_ALLOWED_TOOLS,
      );
      emitToolExecutionAuditEvents({
        sessionId,
        runId,
        toolExecutions: output.toolExecutions || [],
      });
      recordAuditEvent({
        sessionId,
        runId,
        event: {
          type: 'model.usage',
          provider: 'hybridai',
          model: HYBRIDAI_MODEL,
          durationMs: Date.now() - startedAt,
          toolCallCount: (output.toolExecutions || []).length,
        },
      });
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
      storeMessage(sessionId, 'heartbeat', 'heartbeat', 'user', HEARTBEAT_PROMPT);
      storeMessage(sessionId, 'assistant', null, 'assistant', result);
      appendSessionTranscript(agentId, {
        sessionId,
        channelId: heartbeatChannelId,
        role: 'user',
        userId: 'heartbeat',
        username: 'heartbeat',
        content: HEARTBEAT_PROMPT,
      });
      appendSessionTranscript(agentId, {
        sessionId,
        channelId: heartbeatChannelId,
        role: 'assistant',
        userId: 'assistant',
        username: null,
        content: result,
      });
      await maybeCompactSession({
        sessionId,
        agentId,
        chatbotId,
        enableRag: HYBRIDAI_ENABLE_RAG,
        model: HYBRIDAI_MODEL,
        channelId: heartbeatChannelId,
      });
      logger.info({ length: result.length }, 'Heartbeat: agent has something to say');
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
