import { CronExpressionParser } from 'cron-parser';

import {
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  HYBRIDAI_MODELS,
} from './config.js';
import { runAgent } from './agent.js';
import { getActiveContainerCount } from './container-runner.js';
import {
  clearSessionHistory,
  createTask,
  deleteTask,
  getAllSessions,
  getConversationHistory,
  getOrCreateSession,
  getRecentAudit,
  getSessionCount,
  getTasksForSession,
  logAudit,
  storeMessage,
  toggleTask,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
} from './db.js';
import { fetchHybridAIBots } from './hybridai-bots.js';
import { logger } from './logger.js';
import { rearmScheduler } from './scheduler.js';
import { maybeCompactSession } from './session-maintenance.js';
import { appendSessionTranscript } from './session-transcripts.js';
import { processSideEffects } from './side-effects.js';
import { expandSkillInvocation } from './skills.js';
import {
  renderGatewayCommand,
  type GatewayChatRequestBody,
  type GatewayChatResult,
  type GatewayCommandRequest,
  type GatewayCommandResult,
  type GatewayStatus,
} from './gateway-types.js';
import type { ScheduledTask, StoredMessage, ToolProgressEvent } from './types.js';
import { ensureBootstrapFiles } from './workspace.js';
import { buildConversationContext } from './conversation.js';
import { runIsolatedScheduledTask } from './scheduled-task-runner.js';

const BOT_CACHE_TTL = 300_000; // 5 minutes
const MAX_HISTORY_MESSAGES = 40;

export interface GatewayChatRequest {
  sessionId: GatewayChatRequestBody['sessionId'];
  guildId: GatewayChatRequestBody['guildId'];
  channelId: GatewayChatRequestBody['channelId'];
  userId: GatewayChatRequestBody['userId'];
  username: GatewayChatRequestBody['username'];
  content: GatewayChatRequestBody['content'];
  chatbotId?: GatewayChatRequestBody['chatbotId'];
  model?: GatewayChatRequestBody['model'];
  enableRag?: GatewayChatRequestBody['enableRag'];
  onToolProgress?: (event: ToolProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export type { GatewayChatResult, GatewayCommandRequest, GatewayCommandResult, GatewayStatus };
export { renderGatewayCommand };

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function infoCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

export function getGatewayStatus(): GatewayStatus {
  return {
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    sessions: getSessionCount(),
    activeContainers: getActiveContainerCount(),
    defaultModel: HYBRIDAI_MODEL,
    ragDefault: HYBRIDAI_ENABLE_RAG,
    timestamp: new Date().toISOString(),
  };
}

export function getGatewayHistory(sessionId: string, limit = MAX_HISTORY_MESSAGES): StoredMessage[] {
  return getConversationHistory(sessionId, Math.max(1, Math.min(limit, 200))).reverse();
}

export async function handleGatewayMessage(req: GatewayChatRequest): Promise<GatewayChatResult> {
  const startedAt = Date.now();
  const session = getOrCreateSession(req.sessionId, req.guildId, req.channelId);
  const chatbotId = req.chatbotId ?? session.chatbot_id ?? HYBRIDAI_CHATBOT_ID;
  const enableRag = req.enableRag ?? session.enable_rag === 1;
  const model = req.model ?? session.model ?? HYBRIDAI_MODEL;

  if (!chatbotId) {
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: 'No chatbot configured. Set `HYBRIDAI_CHATBOT_ID` or select a bot for this session.',
    };
  }

  const agentId = chatbotId || 'default';
  ensureBootstrapFiles(agentId);

  const history = getConversationHistory(req.sessionId, MAX_HISTORY_MESSAGES);
  const { messages, skills } = buildConversationContext({
    agentId,
    sessionSummary: session.session_summary,
    history,
  });
  messages.push({
    role: 'user',
    content: expandSkillInvocation(req.content, skills),
  });

  try {
    const scheduledTasks: ScheduledTask[] = getTasksForSession(req.sessionId);
    const output = await runAgent(
      req.sessionId,
      messages,
      chatbotId,
      enableRag,
      model,
      agentId,
      req.channelId,
      scheduledTasks,
      undefined,
      req.onToolProgress,
      req.abortSignal,
    );
    processSideEffects(output, req.sessionId, req.channelId);

    if (output.status === 'error') {
      return {
        status: 'error',
        result: null,
        toolsUsed: output.toolsUsed || [],
        error: output.error || 'Unknown agent error.',
      };
    }

    const resultText = output.result || 'No response from agent.';
    storeMessage(req.sessionId, req.userId, req.username, 'user', req.content);
    storeMessage(req.sessionId, 'assistant', null, 'assistant', resultText);
    appendSessionTranscript(agentId, {
      sessionId: req.sessionId,
      channelId: req.channelId,
      role: 'user',
      userId: req.userId,
      username: req.username,
      content: req.content,
    });
    appendSessionTranscript(agentId, {
      sessionId: req.sessionId,
      channelId: req.channelId,
      role: 'assistant',
      userId: 'assistant',
      username: null,
      content: resultText,
    });

    void maybeCompactSession({
      sessionId: req.sessionId,
      agentId,
      chatbotId,
      enableRag,
      model,
      channelId: req.channelId,
    }).catch((err) => {
      logger.warn({ sessionId: req.sessionId, err }, 'Background session compaction failed');
    });

    return {
      status: 'success',
      result: resultText,
      toolsUsed: output.toolsUsed || [],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logAudit('error', req.sessionId, { error: errorMsg }, Date.now() - startedAt);
    logger.error({ sessionId: req.sessionId, err }, 'Gateway message handling failed');
    return {
      status: 'error',
      result: null,
      toolsUsed: [],
      error: errorMsg,
    };
  }
}

export async function runGatewayScheduledTask(
  origSessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
  onResult: (result: string) => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  const session = getOrCreateSession(origSessionId, null, channelId);
  const chatbotId = session.chatbot_id || HYBRIDAI_CHATBOT_ID;
  const model = session.model || HYBRIDAI_MODEL;
  const agentId = chatbotId || 'default';
  if (!chatbotId) return;

  await runIsolatedScheduledTask({
    taskId,
    prompt,
    channelId,
    chatbotId,
    model,
    agentId,
    onResult,
    onError,
  });
}

export async function handleGatewayCommand(req: GatewayCommandRequest): Promise<GatewayCommandResult> {
  const cmd = (req.args[0] || '').toLowerCase();
  const session = getOrCreateSession(req.sessionId, req.guildId, req.channelId);

  switch (cmd) {
    case 'help': {
      const help = [
        '`bot list` — List available bots',
        '`bot set <id|name>` — Set chatbot for this session',
        '`bot info` — Show current chatbot settings',
        '`model list` — List available models',
        '`model set <name>` — Set model for this session',
        '`model info` — Show current model',
        '`rag [on|off]` — Toggle or set RAG mode',
        '`clear` — Clear session history',
        '`status` — Show runtime status',
        '`sessions` — List active sessions',
        '`audit [n]` — Show recent audit entries',
        '`schedule add "<cron>" <prompt>` — Add scheduled task',
        '`schedule list` — List scheduled tasks',
        '`schedule remove <id>` — Remove a task',
        '`schedule toggle <id>` — Enable/disable a task',
      ];
      return infoCommand('HybridClaw Commands', help.join('\n'));
    }

    case 'bot': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          if (bots.length === 0) return plainCommand('No bots available.');
          const list = bots.map((b) =>
            `• ${b.name} (${b.id})${b.description ? ` — ${b.description}` : ''}`
          ).join('\n');
          return infoCommand('Available Bots', list);
        } catch (err) {
          return badCommand('Error', `Failed to fetch bots: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (sub === 'set') {
        const requested = req.args.slice(2).join(' ').trim();
        if (!requested) return badCommand('Usage', 'Usage: `bot set <id|name>`');
        let resolvedBotId = requested;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const matched = bots.find((b) =>
            b.id === requested || b.name.toLowerCase() === requested.toLowerCase()
          );
          if (matched) resolvedBotId = matched.id;
        } catch {
          // keep user-supplied value when lookup fails
        }
        updateSessionChatbot(session.id, resolvedBotId);
        return plainCommand(`Chatbot set to \`${resolvedBotId}\` for this session.`);
      }

      if (sub === 'info') {
        const botId = session.chatbot_id || HYBRIDAI_CHATBOT_ID || 'Not set';
        let botLabel = botId;
        try {
          const bots = await fetchHybridAIBots({ cacheTtlMs: BOT_CACHE_TTL });
          const bot = bots.find((b) => b.id === botId);
          if (bot) botLabel = `${bot.name} (${bot.id})`;
        } catch {
          // keep ID fallback
        }
        const model = session.model || HYBRIDAI_MODEL;
        const ragStatus = session.enable_rag ? 'Enabled' : 'Disabled';
        return infoCommand('Bot Info', `Chatbot: ${botLabel}\nModel: ${model}\nRAG: ${ragStatus}`);
      }

      return badCommand('Usage', 'Usage: `bot list|set <id|name>|info`');
    }

    case 'model': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'list') {
        const current = session.model || HYBRIDAI_MODEL;
        const list = HYBRIDAI_MODELS.map((m) =>
          m === current ? `${m} (current)` : m
        ).join('\n');
        return infoCommand('Available Models', list);
      }

      if (sub === 'set') {
        const modelName = req.args[2];
        if (!modelName) return badCommand('Usage', 'Usage: `model set <name>`');
        if (HYBRIDAI_MODELS.length > 0 && !HYBRIDAI_MODELS.includes(modelName)) {
          return badCommand('Unknown Model', `\`${modelName}\` is not in the available models list.`);
        }
        updateSessionModel(session.id, modelName);
        return plainCommand(`Model set to \`${modelName}\` for this session.`);
      }

      if (sub === 'info') {
        const current = session.model || HYBRIDAI_MODEL;
        return infoCommand('Model Info', `Current model: ${current}\nDefault model: ${HYBRIDAI_MODEL}`);
      }

      return badCommand('Usage', 'Usage: `model list|set <name>|info`');
    }

    case 'rag': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'on' || sub === 'off') {
        updateSessionRag(session.id, sub === 'on');
        return plainCommand(`RAG ${sub === 'on' ? 'enabled' : 'disabled'} for this session.`);
      }
      if (!sub) {
        const nextEnabled = session.enable_rag === 0;
        updateSessionRag(session.id, nextEnabled);
        return plainCommand(`RAG ${nextEnabled ? 'enabled' : 'disabled'} for this session.`);
      }
      return badCommand('Usage', 'Usage: `rag [on|off]`');
    }

    case 'clear': {
      const deleted = clearSessionHistory(session.id);
      return infoCommand('Session Cleared', `Deleted ${deleted} messages. Workspace files preserved.`);
    }

    case 'status': {
      const status = getGatewayStatus();
      const lines = [
        `Uptime: ${formatUptime(status.uptime)}`,
        `Sessions: ${status.sessions}`,
        `Active Containers: ${status.activeContainers}`,
        `Default Model: ${status.defaultModel}`,
        `RAG Default: ${status.ragDefault ? 'On' : 'Off'}`,
      ];
      return infoCommand('Status', lines.join('\n'));
    }

    case 'sessions': {
      const sessions = getAllSessions();
      if (sessions.length === 0) return plainCommand('No active sessions.');
      const list = sessions.slice(0, 20).map((s) =>
        `${s.id} — ${s.message_count} msgs, last active ${s.last_active}`
      ).join('\n');
      return infoCommand('Sessions', list);
    }

    case 'audit': {
      const parsedLimit = parseIntOrNull(req.args[1]);
      const limit = Math.min(parsedLimit ?? 10, 25);
      const entries = getRecentAudit(limit);
      if (entries.length === 0) return plainCommand('No audit entries.');
      const list = entries.map((entry) =>
        `${entry.created_at} ${entry.event}${entry.duration_ms ? ` (${entry.duration_ms}ms)` : ''}`
      ).join('\n');
      return infoCommand('Recent Audit', list);
    }

    case 'schedule': {
      const sub = req.args[1]?.toLowerCase();
      if (sub === 'add') {
        const rest = req.args.slice(2).join(' ');
        const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!cronMatch) {
          return badCommand('Usage', 'Usage: `schedule add "<cron>" <prompt>`');
        }
        const [, cronExpr, prompt] = cronMatch;
        try {
          CronExpressionParser.parse(cronExpr);
        } catch {
          return badCommand('Invalid Cron', `\`${cronExpr}\` is not a valid cron expression.`);
        }
        const taskId = createTask(session.id, req.channelId, cronExpr, prompt);
        rearmScheduler();
        return plainCommand(`Task #${taskId} created: \`${cronExpr}\` — ${prompt}`);
      }

      if (sub === 'list') {
        const tasks = getTasksForSession(session.id);
        if (tasks.length === 0) return plainCommand('No scheduled tasks.');
        const list = tasks.map((task) =>
          `#${task.id} ${task.enabled ? 'enabled' : 'disabled'} \`${task.cron_expr}\` — ${task.prompt.slice(0, 60)}`
        ).join('\n');
        return infoCommand('Scheduled Tasks', list);
      }

      if (sub === 'remove') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId) return badCommand('Usage', 'Usage: `schedule remove <id>`');
        deleteTask(taskId);
        rearmScheduler();
        return plainCommand(`Task #${taskId} removed.`);
      }

      if (sub === 'toggle') {
        const taskId = parseIntOrNull(req.args[2]);
        if (!taskId) return badCommand('Usage', 'Usage: `schedule toggle <id>`');
        const tasks = getTasksForSession(session.id);
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return badCommand('Not Found', `Task #${taskId} was not found in this session.`);
        toggleTask(taskId, !Boolean(task.enabled));
        rearmScheduler();
        return plainCommand(`Task #${taskId} ${task.enabled ? 'disabled' : 'enabled'}.`);
      }

      return badCommand('Usage', 'Usage: `schedule add|list|remove|toggle`');
    }

    default:
      return badCommand('Unknown Command', `Unknown command: \`${cmd || '(empty)'}\`.`);
  }
}
