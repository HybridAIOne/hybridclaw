/**
 * Heartbeat — periodic poll so the agent can proactively check tasks,
 * maintain memory, and reach out when needed.
 */
import { HEARTBEAT_CHANNEL, HEARTBEAT_ENABLED, HEARTBEAT_INTERVAL, HYBRIDAI_CHATBOT_ID, HYBRIDAI_ENABLE_RAG, HYBRIDAI_MODEL } from './config.js';
import { runAgent } from './agent.js';
import { getConversationHistory, getOrCreateSession, getTasksForSession, logRequest, storeMessage } from './db.js';
import { logger } from './logger.js';
import { processSideEffects } from './side-effects.js';
import { buildSkillsPrompt, loadSkills } from './skills.js';
import { buildContextPrompt, loadBootstrapFiles } from './workspace.js';
import type { ChatMessage } from './types.js';

const HEARTBEAT_PROMPT =
  '[Heartbeat poll] Check HEARTBEAT.md for periodic tasks. If nothing needs attention, reply HEARTBEAT_OK.';

const MAX_HEARTBEAT_HISTORY = 5;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function isHeartbeatOk(text: string): boolean {
  return text.trim().replace(/[^a-z_]/gi, '').toUpperCase() === 'HEARTBEATOK';
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
    running = true;

    const sessionId = `heartbeat:${agentId}`;
    const channelId = 'heartbeat';

    try {
      getOrCreateSession(sessionId, null, channelId);

      // Build messages: system context + short history + heartbeat prompt
      const messages: ChatMessage[] = [];

      const contextFiles = loadBootstrapFiles(agentId);
      const contextPrompt = buildContextPrompt(contextFiles);
      const skills = loadSkills(agentId);
      const skillsPrompt = buildSkillsPrompt(skills);
      const systemParts = [contextPrompt, skillsPrompt].filter(Boolean);
      if (systemParts.length > 0) {
        messages.push({ role: 'system', content: systemParts.join('\n\n') });
      }

      const history = getConversationHistory(sessionId, MAX_HEARTBEAT_HISTORY);
      messages.push(...history.reverse().map((msg) => ({
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
      })));
      messages.push({ role: 'user', content: HEARTBEAT_PROMPT });

      const chatbotId = HYBRIDAI_CHATBOT_ID || agentId;
      const heartbeatChannelId = HEARTBEAT_CHANNEL || 'heartbeat';
      const scheduledTasks = getTasksForSession(sessionId);
      const startTime = Date.now();
      const output = await runAgent(sessionId, messages, chatbotId, HYBRIDAI_ENABLE_RAG, HYBRIDAI_MODEL, agentId, heartbeatChannelId, scheduledTasks);
      const duration = Date.now() - startTime;

      logRequest(sessionId, HYBRIDAI_MODEL, chatbotId, messages, output, duration);
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
