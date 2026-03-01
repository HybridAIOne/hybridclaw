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

    try {
      const session = getOrCreateSession(sessionId, null, channelId);

      const history = getConversationHistory(sessionId, MAX_HEARTBEAT_HISTORY);
      const { messages } = buildConversationContext({
        agentId,
        sessionSummary: session.session_summary,
        history,
      });
      messages.push({ role: 'user', content: HEARTBEAT_PROMPT });

      const chatbotId = HYBRIDAI_CHATBOT_ID || agentId;
      const heartbeatChannelId = HEARTBEAT_CHANNEL || 'heartbeat';
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
      processSideEffects(output, sessionId, heartbeatChannelId);

      if (output.status === 'error') {
        logger.warn({ error: output.error }, 'Heartbeat agent error');
        return;
      }

      const result = (output.result || '').trim();

      if (isHeartbeatOk(result)) {
        logger.debug('Heartbeat: HEARTBEAT_OK — nothing to do');
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
      onMessage(result);
    } catch (err) {
      logger.error({ err }, 'Heartbeat failed');
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
