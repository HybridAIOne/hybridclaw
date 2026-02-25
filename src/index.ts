import {
  HEARTBEAT_CHANNEL,
  HEARTBEAT_INTERVAL,
  HYBRIDAI_API_KEY,
  HYBRIDAI_BASE_URL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_ENABLE_RAG,
  HYBRIDAI_MODEL,
  HYBRIDAI_MODELS,
} from './config.js';
import { runAgent } from './agent.js';
import {
  clearSessionHistory,
  createTask,
  deleteTask,
  getAllSessions,
  getConversationHistory,
  getOrCreateSession,
  getRecentAudit,
  getTasksForSession,
  initDatabase,
  logAudit,
  storeMessage,
  toggleTask,
  updateSessionChatbot,
  updateSessionModel,
  updateSessionRag,
} from './db.js';
import { processSideEffects } from './side-effects.js';
import {
  buildResponseText,
  formatError,
  formatInfo,
  initDiscord,
  type ReplyFn,
  sendToChannel,
} from './discord.js';
import { getUptime, startHealthServer } from './health.js';
import { getActiveContainerCount } from './container-runner.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import type { ChatMessage, HybridAIBot } from './types.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { buildSkillsPrompt, loadSkills } from './skills.js';
import { buildContextPrompt, ensureBootstrapFiles, loadBootstrapFiles } from './workspace.js';

// --- Bot listing cache ---
let botCache: HybridAIBot[] | null = null;
let botCacheTime = 0;
const BOT_CACHE_TTL = 300_000; // 5 minutes

async function fetchBots(): Promise<HybridAIBot[]> {
  if (botCache && Date.now() - botCacheTime < BOT_CACHE_TTL) {
    return botCache;
  }

  const url = `${HYBRIDAI_BASE_URL}/api/v1/bot-management/bots`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${HYBRIDAI_API_KEY}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch bots: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as
    | { data?: Record<string, unknown>[]; bots?: Record<string, unknown>[]; items?: Record<string, unknown>[] }
    | Record<string, unknown>[];
  const raw = Array.isArray(data) ? data : (data.data || data.bots || data.items || []);

  // Normalize fields — the API may return bot_name/chatbot_id instead of name/id
  botCache = raw.map((item) => ({
    id: String(item.id ?? item._id ?? item.chatbot_id ?? item.bot_id ?? ''),
    name: String(item.bot_name ?? item.name ?? 'Unnamed'),
    description: item.description != null ? String(item.description) : undefined,
  }));
  botCacheTime = Date.now();
  return botCache;
}

// --- Message handler ---
async function handleMessage(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: ReplyFn,
): Promise<void> {
  const startTime = Date.now();
  const session = getOrCreateSession(sessionId, guildId, channelId);

  // Store user message
  storeMessage(sessionId, userId, username, 'user', content);

  const chatbotId = session.chatbot_id || HYBRIDAI_CHATBOT_ID;
  const enableRag = session.enable_rag === 1;
  const model = session.model || HYBRIDAI_MODEL;
  const agentId = chatbotId || 'default';

  // Ensure workspace bootstrap files
  ensureBootstrapFiles(agentId);

  // Build conversation with context files injected as system message
  const messages: ChatMessage[] = [];

  const contextFiles = loadBootstrapFiles(agentId);
  const contextPrompt = buildContextPrompt(contextFiles);
  const skills = loadSkills(agentId);
  const skillsPrompt = buildSkillsPrompt(skills);
  const systemParts = [contextPrompt, skillsPrompt].filter(Boolean);
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }

  const history = getConversationHistory(sessionId, 40);
  messages.push(...history.reverse().map((msg) => ({
    role: msg.role as 'user' | 'assistant' | 'system',
    content: msg.content,
  })));

  if (!chatbotId) {
    await reply(formatError('No Chatbot', 'No chatbot configured. Use `!claw bot set <id>` or set `HYBRIDAI_CHATBOT_ID` env var.'));
    return;
  }

  try {
    const scheduledTasks = getTasksForSession(sessionId);
    const output = await runAgent(sessionId, messages, chatbotId, enableRag, model, agentId, channelId, scheduledTasks);
    processSideEffects(output, sessionId, channelId);

    if (output.status === 'error') {
      await reply(formatError('Agent Error', output.error || 'Unknown error'));
      return;
    }

    const result = output.result || 'No response from agent.';

    // Store assistant response
    storeMessage(sessionId, 'assistant', null, 'assistant', result);

    await reply(buildResponseText(result, output.toolsUsed));
  } catch (err) {
    const duration = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logAudit('error', sessionId, { error: errorMsg }, duration);
    logger.error({ sessionId, err }, 'Message handling failed');
    await reply(formatError('Error', errorMsg));
  }
}

// --- Command handler ---
async function handleCommand(
  sessionId: string,
  guildId: string | null,
  channelId: string,
  args: string[],
  reply: ReplyFn,
): Promise<void> {
  const cmd = args[0];

  switch (cmd) {
    case 'help': {
      const help = [
        '`!claw <message>` — Talk to the AI agent',
        '`!claw bot list` — List available HybridAI bots',
        '`!claw bot set <id>` — Set chatbot for this channel',
        '`!claw bot info` — Show current chatbot',
        '`!claw model list` — List available models',
        '`!claw model set <name>` — Set model for this channel',
        '`!claw model info` — Show current model',
        '`!claw rag on/off` — Toggle RAG for this channel',
        '`!claw clear` — Clear conversation history (keeps workspace)',
        '`!claw status` — Show bot status',
        '`!claw sessions` — List active sessions',
        '`!claw logs [n]` — Show recent request logs',
        '`!claw audit [n]` — Show recent audit entries',
        '`!claw schedule add "<cron>" <prompt>` — Add scheduled task',
        '`!claw schedule list` — List scheduled tasks',
        '`!claw schedule remove <id>` — Remove a task',
        '`!claw schedule toggle <id>` — Enable/disable a task',
      ];
      await reply(formatInfo('HybridClaw Commands', help.join('\n')));
      break;
    }

    case 'bot': {
      const sub = args[1]?.toLowerCase();

      if (sub === 'list') {
        try {
          const bots = await fetchBots();
          if (bots.length === 0) {
            await reply('No bots available.');
            return;
          }
          const list = bots.map((b) =>
            `**${b.name}** (\`${b.id}\`)${b.description ? ` — ${b.description}` : ''}`
          ).join('\n');
          await reply(formatInfo('Available Bots', list));
        } catch (err) {
          await reply(formatError('Error', `Failed to fetch bots: ${err instanceof Error ? err.message : String(err)}`));
        }
      } else if (sub === 'set' && args[2]) {
        const session = getOrCreateSession(sessionId, guildId, channelId);
        updateSessionChatbot(session.id, args[2]);
        await reply(`Chatbot set to \`${args[2]}\` for this channel.`);
      } else if (sub === 'info') {
        const session = getOrCreateSession(sessionId, guildId, channelId);
        const botId = session.chatbot_id || HYBRIDAI_CHATBOT_ID || 'Not set';
        let botName = botId;
        try {
          const bots = await fetchBots();
          const bot = bots.find((b) => b.id === botId);
          if (bot) botName = `${bot.name} (\`${bot.id}\`)`;
        } catch { /* use ID */ }
        const model = session.model || HYBRIDAI_MODEL;
        const ragStatus = session.enable_rag ? 'Enabled' : 'Disabled';
        await reply(formatInfo('Bot Info', `**Chatbot:** ${botName}\n**Model:** ${model}\n**RAG:** ${ragStatus}`));
      } else {
        await reply('Usage: `!claw bot list|set <id>|info`');
      }
      break;
    }

    case 'model': {
      const sub = args[1]?.toLowerCase();

      if (sub === 'list') {
        const models = HYBRIDAI_MODELS;
        const session = getOrCreateSession(sessionId, guildId, channelId);
        const current = session.model || HYBRIDAI_MODEL;
        const list = models.map((m) =>
          m === current ? `**${m}** *(current)*` : m
        ).join('\n');
        await reply(formatInfo('Available Models', list));
      } else if (sub === 'set' && args[2]) {
        const modelName = args[2];
        if (HYBRIDAI_MODELS.length > 0 && !HYBRIDAI_MODELS.includes(modelName)) {
          await reply(formatError('Unknown Model', `\`${modelName}\` is not in the available models list. Use \`!claw model list\` to see options.`));
          return;
        }
        const session = getOrCreateSession(sessionId, guildId, channelId);
        updateSessionModel(session.id, modelName);
        await reply(`Model set to \`${modelName}\` for this channel.`);
      } else if (sub === 'info') {
        const session = getOrCreateSession(sessionId, guildId, channelId);
        const current = session.model || HYBRIDAI_MODEL;
        await reply(formatInfo('Model Info', `**Current model:** ${current}\n**Default:** ${HYBRIDAI_MODEL}`));
      } else {
        await reply('Usage: `!claw model list|set <name>|info`');
      }
      break;
    }

    case 'rag': {
      const toggle = args[1]?.toLowerCase();
      if (toggle === 'on' || toggle === 'off') {
        const session = getOrCreateSession(sessionId, guildId, channelId);
        updateSessionRag(session.id, toggle === 'on');
        await reply(`RAG ${toggle === 'on' ? 'enabled' : 'disabled'} for this channel.`);
      } else {
        await reply('Usage: `!claw rag on|off`');
      }
      break;
    }

    case 'clear': {
      const session = getOrCreateSession(sessionId, guildId, channelId);
      const deleted = clearSessionHistory(session.id);
      await reply(formatInfo('Session Cleared', `Deleted ${deleted} messages. Workspace files preserved.`));
      break;
    }

    case 'status': {
      const sessions = getAllSessions();
      const lines = [
        `**Uptime:** ${formatUptime(getUptime())}`,
        `**Sessions:** ${sessions.length}`,
        `**Active Containers:** ${getActiveContainerCount()}`,
        `**Default Model:** ${HYBRIDAI_MODEL}`,
        `**RAG Default:** ${HYBRIDAI_ENABLE_RAG ? 'On' : 'Off'}`,
      ];
      await reply(formatInfo('Status', lines.join('\n')));
      break;
    }

    case 'sessions': {
      const sessions = getAllSessions();
      if (sessions.length === 0) {
        await reply('No active sessions.');
        return;
      }
      const list = sessions.slice(0, 15).map((s) =>
        `\`${s.id}\` — ${s.message_count} msgs, last active ${s.last_active}`
      ).join('\n');
      await reply(formatInfo('Sessions', list));
      break;
    }

    case 'audit': {
      const limit = parseInt(args[1] || '10', 10);
      const entries = getRecentAudit(Math.min(limit, 25));
      if (entries.length === 0) {
        await reply('No audit entries.');
        return;
      }
      const list = entries.map((e) =>
        `\`${e.created_at}\` **${e.event}** ${e.duration_ms ? `(${e.duration_ms}ms)` : ''}`
      ).join('\n');
      await reply(formatInfo('Recent Audit', list));
      break;
    }

    case 'schedule': {
      const sub = args[1]?.toLowerCase();

      if (sub === 'add') {
        const rest = args.slice(2).join(' ');
        const cronMatch = rest.match(/^"([^"]+)"\s+(.+)$/);
        if (!cronMatch) {
          await reply('Usage: `!claw schedule add "<cron>" <prompt>`');
          return;
        }
        const [, cronExpr, prompt] = cronMatch;
        try {
          CronExpressionParser.parse(cronExpr);
        } catch {
          await reply(formatError('Invalid Cron', `\`${cronExpr}\` is not a valid cron expression.`));
          return;
        }
        const session = getOrCreateSession(sessionId, guildId, channelId);
        const taskId = createTask(session.id, channelId, cronExpr, prompt);
        await reply(`Task #${taskId} created: \`${cronExpr}\` — ${prompt}`);
      } else if (sub === 'list') {
        const session = getOrCreateSession(sessionId, guildId, channelId);
        const tasks = getTasksForSession(session.id);
        if (tasks.length === 0) {
          await reply('No scheduled tasks.');
          return;
        }
        const list = tasks.map((t) =>
          `#${t.id} ${t.enabled ? '✓' : '✗'} \`${t.cron_expr}\` — ${t.prompt.slice(0, 60)}`
        ).join('\n');
        await reply(formatInfo('Scheduled Tasks', list));
      } else if (sub === 'remove' && args[2]) {
        deleteTask(parseInt(args[2], 10));
        await reply(`Task #${args[2]} removed.`);
      } else if (sub === 'toggle' && args[2]) {
        const id = parseInt(args[2], 10);
        const tasks = getTasksForSession(sessionId);
        const task = tasks.find((t) => t.id === id);
        toggleTask(id, task ? !task.enabled : true);
        await reply(`Task #${args[2]} toggled.`);
      } else {
        await reply('Usage: `!claw schedule add|list|remove|toggle`');
      }
      break;
    }

    default:
      await reply(`Unknown command: \`${cmd}\`. Try \`!claw help\`.`);
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// --- Scheduled task runner (OpenClaw style: isolated session, tools disabled, direct post) ---
async function runScheduledTask(origSessionId: string, channelId: string, prompt: string, taskId: number): Promise<void> {
  // Config from original session
  const session = getOrCreateSession(origSessionId, null, channelId);
  const chatbotId = session.chatbot_id || HYBRIDAI_CHATBOT_ID;
  const model = session.model || HYBRIDAI_MODEL;
  const agentId = chatbotId || 'default';

  if (!chatbotId) return;

  // Isolated run — fresh session, no history, only cron tool available
  const cronSessionId = `cron:${taskId}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  try {
    const output = await runAgent(cronSessionId, messages, chatbotId, false, model, agentId, channelId, undefined, ['cron']);
    if (output.status === 'success' && output.result) {
      await sendToChannel(channelId, output.result);
    }
  } catch (err) {
    logger.error({ taskId, channelId, err }, 'Scheduled task failed');
  }
}

// --- Import for schedule validation ---
import { CronExpressionParser } from 'cron-parser';

// --- Graceful shutdown ---
import { stopAllContainers } from './container-runner.js';

function setupShutdown(): void {
  const shutdown = () => {
    logger.info('Shutting down...');
    stopHeartbeat();
    stopAllContainers();
    stopScheduler();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// --- Main ---
async function main(): Promise<void> {
  logger.info('Starting HybridClaw');

  initDatabase();
  startHealthServer();

  const client = initDiscord(handleMessage, handleCommand);

  // Start heartbeat after Discord is connected
  client.once('ready', () => {
    const agentId = HYBRIDAI_CHATBOT_ID || 'default';
    startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
      if (HEARTBEAT_CHANNEL) {
        sendToChannel(HEARTBEAT_CHANNEL, text).catch((err) => {
          logger.error({ err }, 'Failed to send heartbeat message');
        });
      }
    });
  });

  startScheduler(runScheduledTask);
  setupShutdown();

  logger.info('HybridClaw started');
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start HybridClaw');
  process.exit(1);
});
