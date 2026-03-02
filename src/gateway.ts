import {
  DISCORD_TOKEN,
  HEARTBEAT_CHANNEL,
  HEARTBEAT_INTERVAL,
  HYBRIDAI_CHATBOT_ID,
  PROACTIVE_QUEUE_OUTSIDE_HOURS,
  onConfigChange,
} from './config.js';
import { stopAllContainers } from './container-runner.js';
import { closeDatabase } from './db.js';
import {
  deleteQueuedProactiveMessage,
  enqueueProactiveMessage,
  getQueuedProactiveMessageCount,
  initDatabase,
  listQueuedProactiveMessages,
} from './db.js';
import {
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
  renderGatewayCommand,
  runGatewayScheduledTask,
} from './gateway-service.js';
import { getInflightCount, startHealthServer, stopAcceptingRequests } from './health.js';
import { startHeartbeat, stopHeartbeat } from './heartbeat.js';
import { logger } from './logger.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import {
  buildResponseText,
  formatError,
  formatInfo,
  initDiscord,
  sendToChannel,
  type EditFn,
  type ReplyFn,
} from './discord.js';
import type { ToolProgressEvent } from './types.js';
import { isWithinActiveHours, proactiveWindowLabel } from './proactive-policy.js';

let detachConfigListener: (() => void) | null = null;
let proactiveFlushTimer: ReturnType<typeof setInterval> | null = null;

const MAX_QUEUED_PROACTIVE_MESSAGES = 100;

function isDiscordChannelId(channelId: string): boolean {
  return /^\d{16,22}$/.test(channelId);
}

async function deliverProactiveMessage(channelId: string, text: string, source: string): Promise<void> {
  if (!isWithinActiveHours()) {
    if (PROACTIVE_QUEUE_OUTSIDE_HOURS) {
      const { queued, dropped } = enqueueProactiveMessage(channelId, text, source, MAX_QUEUED_PROACTIVE_MESSAGES);
      logger.info(
        { source, channelId, queued, dropped, activeHours: proactiveWindowLabel() },
        'Proactive message queued (outside active hours)',
      );
      return;
    }
    logger.info({ source, channelId, activeHours: proactiveWindowLabel() }, 'Proactive message suppressed (outside active hours)');
    return;
  }

  await sendProactiveMessageNow(channelId, text, source);
}

async function sendProactiveMessageNow(channelId: string, text: string, source: string): Promise<void> {
  if (!DISCORD_TOKEN || !isDiscordChannelId(channelId)) {
    logger.info({ source, channelId, text }, 'Proactive message (no Discord delivery)');
    return;
  }

  try {
    await sendToChannel(channelId, text);
  } catch (error) {
    logger.warn({ source, channelId, error }, 'Failed to send proactive message to Discord channel');
    logger.info({ source, channelId, text }, 'Proactive message fallback');
  }
}

async function flushQueuedProactiveMessages(): Promise<void> {
  if (!isWithinActiveHours()) return;
  const pending = listQueuedProactiveMessages(MAX_QUEUED_PROACTIVE_MESSAGES);
  if (pending.length === 0) return;
  logger.info(
    { flushing: pending.length, queued: getQueuedProactiveMessageCount() },
    'Flushing queued proactive messages',
  );

  for (const item of pending) {
    if (!isWithinActiveHours()) break;
    await sendProactiveMessageNow(item.channel_id, item.text, `${item.source}:queued`);
    deleteQueuedProactiveMessage(item.id);
  }
}

async function startDiscordIntegration(): Promise<void> {
  if (!DISCORD_TOKEN) {
    logger.info('DISCORD_TOKEN not set; Discord integration disabled');
    return;
  }

  initDiscord(
    async (
      sessionId: string,
      guildId: string | null,
      channelId: string,
      userId: string,
      username: string,
      content: string,
      reply: ReplyFn,
      sendWorking: () => Promise<EditFn | null>,
    ) => {
      let editWorking: EditFn | null = null;
      const activeTools: string[] = [];

      // Send "working..." placeholder immediately so user sees feedback
      editWorking = await sendWorking();

      const onToolProgress = editWorking
        ? (event: ToolProgressEvent): void => {
            if (event.phase === 'start') {
              activeTools.push(event.toolName);
              const toolsText = activeTools.join(', ');
              editWorking!(`_Working... (${toolsText})_`).catch(() => {
                editWorking = null;
              });
            }
          }
        : undefined;

      try {
        const result = await handleGatewayMessage({
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          content,
          onToolProgress,
          onProactiveMessage: async (messageText) => {
            await deliverProactiveMessage(channelId, messageText, 'delegate');
          },
        });
        const responseText = result.status === 'error'
          ? formatError('Agent Error', result.error || 'Unknown error')
          : buildResponseText(result.result || 'No response from agent.', result.toolsUsed);

        if (editWorking) {
          // Edit the working message with the final response
          await editWorking(responseText);
        } else {
          await reply(responseText);
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logger.error({ error, sessionId, channelId }, 'Discord message handling failed');
        const errorText = formatError('Gateway Error', text);
        if (editWorking) {
          await editWorking(errorText);
        } else {
          await reply(errorText);
        }
      }
    },
    async (
      sessionId: string,
      guildId: string | null,
      channelId: string,
      args: string[],
      reply: ReplyFn,
    ) => {
      try {
        const result = await handleGatewayCommand({
          sessionId,
          guildId,
          channelId,
          args,
        });
        if (result.kind === 'error') {
          await reply(formatError(result.title || 'Error', result.text));
          return;
        }
        if (result.kind === 'info') {
          await reply(formatInfo(result.title || 'Info', result.text));
          return;
        }
        await reply(renderGatewayCommand(result));
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logger.error({ error, sessionId, channelId, args }, 'Discord command handling failed');
        await reply(formatError('Gateway Error', text));
      }
    },
  );
  logger.info('Discord integration started inside gateway');
}

const DRAIN_TIMEOUT_MS = 10_000;

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received');

  if (detachConfigListener) {
    detachConfigListener();
    detachConfigListener = null;
  }
  if (proactiveFlushTimer) {
    clearInterval(proactiveFlushTimer);
    proactiveFlushTimer = null;
  }

  stopAcceptingRequests();
  stopHeartbeat();
  stopScheduler();

  // Drain in-flight requests
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (getInflightCount() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (getInflightCount() > 0) {
    logger.warn({ inflight: getInflightCount() }, 'Drain timeout reached, forcing shutdown');
  }

  stopAllContainers();
  closeDatabase();
  process.exit(0);
}

function setupShutdown(): void {
  const handler = (signal: string) => {
    void gracefulShutdown(signal).catch((err) => {
      logger.error({ err }, 'Shutdown error');
      process.exit(1);
    });
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function runScheduledTask(
  sessionId: string,
  channelId: string,
  prompt: string,
  taskId: number,
): Promise<void> {
  await runGatewayScheduledTask(
    sessionId,
    channelId,
    prompt,
    taskId,
    async (result) => {
      await deliverProactiveMessage(channelId, result, `schedule:${taskId}`);
      logger.info({ taskId, channelId, result }, 'Scheduled task completed');
    },
    (error) => {
      logger.error({ taskId, channelId, error }, 'Scheduled task failed');
    },
  );
}

function startOrRestartHeartbeat(): void {
  stopHeartbeat();
  const agentId = HYBRIDAI_CHATBOT_ID || 'default';
  startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
    const channelId = HEARTBEAT_CHANNEL || 'heartbeat';
    void deliverProactiveMessage(channelId, text, 'heartbeat');
    logger.info({ text }, 'Heartbeat message');
  });
}

async function main(): Promise<void> {
  logger.info('Starting HybridClaw gateway');
  initDatabase();
  startHealthServer();
  setupShutdown();
  await startDiscordIntegration();

  startOrRestartHeartbeat();
  detachConfigListener = onConfigChange((next, prev) => {
    const shouldRestart =
      next.hybridai.defaultChatbotId !== prev.hybridai.defaultChatbotId
      || next.heartbeat.intervalMs !== prev.heartbeat.intervalMs
      || next.heartbeat.enabled !== prev.heartbeat.enabled;
    if (!shouldRestart) return;

    logger.info(
      {
        heartbeatEnabled: next.heartbeat.enabled,
        heartbeatIntervalMs: next.heartbeat.intervalMs,
        heartbeatAgentId: next.hybridai.defaultChatbotId || 'default',
      },
      'Config changed, restarting heartbeat',
    );
    startOrRestartHeartbeat();
  });
  startScheduler(runScheduledTask);
  proactiveFlushTimer = setInterval(() => {
    void flushQueuedProactiveMessages().catch((err) => {
      logger.warn({ err }, 'Failed to flush queued proactive messages');
    });
  }, 60_000);
  void flushQueuedProactiveMessages().catch((err) => {
    logger.warn({ err }, 'Initial proactive queue flush failed');
  });

  logger.info({ ...getGatewayStatus(), discord: !!DISCORD_TOKEN }, 'HybridClaw gateway started');
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
