import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import {
  buildResponseText,
  formatError,
  formatInfo,
} from '../channels/discord/delivery.js';
import { rewriteUserMentionsForMessage } from '../channels/discord/mentions.js';
import {
  initDiscord,
  type ReplyFn,
  sendToChannel,
  setDiscordMaintenancePresence,
} from '../channels/discord/runtime.js';
import {
  DISCORD_TOKEN,
  getConfigSnapshot,
  HEARTBEAT_CHANNEL,
  HEARTBEAT_INTERVAL,
  HYBRIDAI_CHATBOT_ID,
  HYBRIDAI_MODEL,
  onConfigChange,
  PROACTIVE_QUEUE_OUTSIDE_HOURS,
} from '../config/config.js';
import {
  deleteQueuedProactiveMessage,
  enqueueProactiveMessage,
  getMostRecentSessionChannelId,
  getQueuedProactiveMessageCount,
  initDatabase,
  listQueuedProactiveMessages,
} from '../memory/db.js';
import { stopAllExecutions } from '../agent/executor.js';
import {
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
  renderGatewayCommand,
  runGatewayScheduledTask,
} from './gateway-service.js';
import { startHealthServer } from './health.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import { logger } from '../logger.js';
import { memoryService } from '../memory/memory-service.js';
import {
  startObservabilityIngest,
  stopObservabilityIngest,
} from '../audit/observability-ingest.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { resolveAgentIdForModel } from '../providers/factory.js';
import {
  rearmScheduler,
  type SchedulerDispatchRequest,
  startScheduler,
  stopScheduler,
} from '../scheduler/scheduler.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import type { ArtifactMetadata } from '../types.js';

let detachConfigListener: (() => void) | null = null;
let proactiveFlushTimer: ReturnType<typeof setInterval> | null = null;
let memoryConsolidationTimer: ReturnType<typeof setInterval> | null = null;

const MAX_QUEUED_PROACTIVE_MESSAGES = 100;
const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;

interface PendingApprovalPrompt {
  prompt: string;
  createdAt: number;
  expiresAt: number;
  userId: string;
}

const pendingApprovalBySession = new Map<string, PendingApprovalPrompt>();

function isDiscordChannelId(channelId: string): boolean {
  return /^\d{16,22}$/.test(channelId);
}

function buildArtifactAttachments(
  artifacts?: ArtifactMetadata[],
): AttachmentBuilder[] {
  if (!artifacts || artifacts.length === 0) return [];
  const attachments: AttachmentBuilder[] = [];
  for (const artifact of artifacts) {
    try {
      const content = fs.readFileSync(artifact.path);
      attachments.push(
        new AttachmentBuilder(content, { name: artifact.filename }),
      );
    } catch (error) {
      logger.warn(
        { artifactPath: artifact.path, error },
        'Failed to read artifact for Discord attachment',
      );
    }
  }
  return attachments;
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function simplifyImageAttachmentNarration(
  text: string,
  artifacts?: ArtifactMetadata[],
): string {
  if (!text.trim() || !artifacts || artifacts.length === 0) return text;

  const imageArtifacts = artifacts.filter((artifact) =>
    artifact.mimeType.startsWith('image/'),
  );
  if (imageArtifacts.length === 0) return text;

  const pathHints = new Set<string>();
  for (const artifact of imageArtifacts) {
    const normalizedPath = normalizePathForMatch(artifact.path);
    const filename = normalizePathForMatch(artifact.filename);
    if (normalizedPath) pathHints.add(normalizedPath);
    if (filename) pathHints.add(filename);
    if (filename) pathHints.add(`/workspace/.browser-artifacts/${filename}`);
    if (filename) pathHints.add(`.browser-artifacts/${filename}`);
  }

  const pathishLine =
    /(^`?\s*(\.\/|\/|~\/|[a-zA-Z]:\\|\.browser-artifacts\/))|([\\/][^\\/\s]+\.[a-zA-Z0-9]{1,8})/;
  const locationNarration =
    /(workspace|saved to|find it at|located at|liegt unter|pfad|path)/i;

  let removedPathNarration = false;
  const keptLines: string[] = [];
  for (const line of text.split('\n')) {
    const normalizedLine = normalizePathForMatch(line);
    const mentionsArtifact = Array.from(pathHints).some((hint) =>
      normalizedLine.includes(hint),
    );
    const isPathLine = pathishLine.test(line.trim());
    const isLocationNarration = locationNarration.test(line);
    if (mentionsArtifact && (isPathLine || isLocationNarration)) {
      removedPathNarration = true;
      continue;
    }
    keptLines.push(line);
  }

  if (!removedPathNarration) return text;

  const cleaned = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (cleaned) return cleaned;
  return imageArtifacts.length === 1 ? 'Here it is.' : 'Here they are.';
}

function isApprovalPromptForPrivateDelivery(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('i need your approval before i') &&
    normalized.includes('approval id:') &&
    normalized.includes('reply `yes`')
  );
}

function parseApprovalExpiryMs(prompt: string): number {
  const match = prompt.match(/Approval expires in\s+(\d+)s\./i);
  const seconds = match ? Number.parseInt(match[1], 10) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return APPROVAL_PROMPT_DEFAULT_TTL_MS;
  }
  return Math.max(15_000, seconds * 1_000);
}

function extractApprovalId(prompt: string): string {
  const match = prompt.match(/Approval ID:\s*([a-f0-9-]{6,64})/i);
  return match?.[1]?.trim() || '';
}

function cleanupExpiredPendingApprovals(): void {
  const now = Date.now();
  for (const [sessionId, pending] of pendingApprovalBySession.entries()) {
    if (pending.expiresAt <= now) {
      pendingApprovalBySession.delete(sessionId);
    }
  }
}

async function handleApprovalCommand(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  args: string[];
  reply: ReplyFn;
}): Promise<boolean> {
  const { sessionId, guildId, channelId, userId, username, args, reply } =
    params;
  if ((args[0] || '').toLowerCase() !== 'approve') return false;

  cleanupExpiredPendingApprovals();
  const pending = pendingApprovalBySession.get(sessionId) || null;
  const action = (args[1] || 'view').trim().toLowerCase();
  const providedApprovalId = (args[2] || '').trim();
  const currentApprovalId = pending ? extractApprovalId(pending.prompt) : '';
  const approvalId = providedApprovalId || currentApprovalId;

  if (action === 'view' || action === 'status' || action === 'show') {
    if (!pending || pending.userId !== userId) {
      await reply('No pending approval request for you in this session.');
      return true;
    }
    await reply(formatInfo('Pending Approval', pending.prompt));
    return true;
  }

  const directive = (() => {
    if (action === 'yes' || action === '1') return 'yes';
    if (action === 'session' || action === '2') return 'yes for session';
    if (action === 'agent' || action === '3') return 'yes for agent';
    if (
      action === 'no' ||
      action === 'deny' ||
      action === 'skip' ||
      action === '4'
    ) {
      return 'no';
    }
    return null;
  })();

  if (!directive) {
    await reply(
      'Usage: `/approve action:view|yes|session|agent|no [approval_id]`',
    );
    return true;
  }

  if (!approvalId && !pending) {
    await reply('No pending approval request for this session.');
    return true;
  }

  const approvalContent = approvalId ? `${directive} ${approvalId}` : directive;
  const approvalResult = await handleGatewayMessage({
    sessionId,
    guildId,
    channelId,
    userId,
    username,
    content: approvalContent,
    media: [],
  });
  if (approvalResult.status === 'error') {
    await reply(
      formatError('Approval Error', approvalResult.error || 'Unknown error'),
    );
    return true;
  }
  if (isSilentReply(approvalResult.result)) {
    pendingApprovalBySession.delete(sessionId);
    return true;
  }
  const approvalResultText = stripSilentToken(String(approvalResult.result));
  if (!approvalResultText.trim()) {
    pendingApprovalBySession.delete(sessionId);
    return true;
  }

  const resultText = buildResponseText(
    approvalResultText,
    approvalResult.toolsUsed,
  );
  if (isApprovalPromptForPrivateDelivery(resultText)) {
    pendingApprovalBySession.set(sessionId, {
      prompt: resultText,
      createdAt: Date.now(),
      expiresAt: Date.now() + parseApprovalExpiryMs(resultText),
      userId,
    });
    await reply(formatInfo('Pending Approval', resultText));
    return true;
  }

  pendingApprovalBySession.delete(sessionId);
  const attachments = buildArtifactAttachments(approvalResult.artifacts);
  await reply(resultText, attachments);
  return true;
}

async function deliverProactiveMessage(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<void> {
  if (!isWithinActiveHours()) {
    if (PROACTIVE_QUEUE_OUTSIDE_HOURS) {
      const { queued, dropped } = enqueueProactiveMessage(
        channelId,
        text,
        source,
        MAX_QUEUED_PROACTIVE_MESSAGES,
      );
      logger.info(
        {
          source,
          channelId,
          queued,
          dropped,
          artifactCount: artifacts?.length || 0,
          activeHours: proactiveWindowLabel(),
        },
        'Proactive message queued (outside active hours)',
      );
      if (artifacts && artifacts.length > 0) {
        logger.warn(
          { source, channelId, artifactCount: artifacts.length },
          'Queued proactive message does not persist attachments; only text was queued',
        );
      }
      return;
    }
    logger.info(
      { source, channelId, activeHours: proactiveWindowLabel() },
      'Proactive message suppressed (outside active hours)',
    );
    return;
  }

  await sendProactiveMessageNow(channelId, text, source, artifacts);
}

async function sendProactiveMessageNow(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<void> {
  const attachments = buildArtifactAttachments(artifacts);
  if (!isDiscordChannelId(channelId)) {
    const { queued, dropped } = enqueueProactiveMessage(
      channelId,
      text,
      source,
      MAX_QUEUED_PROACTIVE_MESSAGES,
    );
    logger.info(
      {
        source,
        channelId,
        queued,
        dropped,
        artifactCount: attachments.length,
      },
      'Proactive message queued for local channel delivery',
    );
    if (attachments.length > 0) {
      logger.warn(
        { source, channelId, artifactCount: attachments.length },
        'Queued proactive local delivery does not persist attachments; only text was queued',
      );
    }
    return;
  }

  if (!DISCORD_TOKEN) {
    logger.info(
      { source, channelId, text, artifactCount: attachments.length },
      'Proactive message (no Discord delivery)',
    );
    return;
  }

  try {
    await sendToChannel(channelId, text, attachments);
  } catch (error) {
    logger.warn(
      { source, channelId, error, artifactCount: attachments.length },
      'Failed to send proactive message to Discord channel',
    );
    logger.info({ source, channelId, text }, 'Proactive message fallback');
  }
}

async function deliverWebhookMessage(
  webhookUrl: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      text,
      source,
      artifactCount: artifacts?.length || 0,
      artifacts: (artifacts || []).map((artifact) => ({
        filename: artifact.filename,
        mimeType: artifact.mimeType,
      })),
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Webhook delivery failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }
}

function resolveLastUsedDiscordChannelId(): string | null {
  const channelId = getMostRecentSessionChannelId();
  if (!channelId) return null;
  return isDiscordChannelId(channelId) ? channelId : null;
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
    if (!isDiscordChannelId(item.channel_id)) continue;
    await sendProactiveMessageNow(
      item.channel_id,
      item.text,
      `${item.source}:queued`,
    );
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
      media,
      _reply: ReplyFn,
      context,
    ) => {
      try {
        let sawTextDelta = false;
        const streamFilter = createSilentReplyStreamFilter();
        const appendStreamText = async (text: string): Promise<void> => {
          if (!text) return;
          if (!sawTextDelta) {
            sawTextDelta = true;
            context.emitLifecyclePhase('streaming');
          }
          await context.stream.append(text);
        };
        const result = await handleGatewayMessage({
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          content,
          media,
          onTextDelta: (delta) => {
            const filteredDelta = streamFilter.push(delta);
            if (!filteredDelta) return;
            void appendStreamText(filteredDelta);
          },
          onToolProgress: (event) => {
            if (sawTextDelta) return;
            if (event.phase === 'start') {
              context.emitLifecyclePhase('toolUse');
            } else {
              context.emitLifecyclePhase('thinking');
            }
          },
          onProactiveMessage: async (message) => {
            await deliverProactiveMessage(
              channelId,
              message.text,
              'delegate',
              message.artifacts,
            );
          },
          abortSignal: context.abortSignal,
        });
        if (result.status === 'error') {
          const errorText = formatError(
            'Agent Error',
            result.error || 'Unknown error',
          );
          await context.stream.fail(errorText);
          return;
        }
        const bufferedDelta = streamFilter.flush();
        if (bufferedDelta) {
          await appendStreamText(bufferedDelta);
        }
        if (streamFilter.isSilent() || isSilentReply(result.result)) {
          pendingApprovalBySession.delete(sessionId);
          await context.stream.discard();
          return;
        }
        const attachments = buildArtifactAttachments(result.artifacts);
        const cleanedResultText = stripSilentToken(String(result.result));
        if (!cleanedResultText.trim()) {
          pendingApprovalBySession.delete(sessionId);
          await context.stream.discard();
          return;
        }
        const userText = simplifyImageAttachmentNarration(
          cleanedResultText,
          result.artifacts,
        );
        const renderedText = await rewriteUserMentionsForMessage(
          userText,
          context.sourceMessage,
          context.mentionLookup,
        );
        const responseText = buildResponseText(renderedText, result.toolsUsed);
        if (isApprovalPromptForPrivateDelivery(responseText)) {
          pendingApprovalBySession.set(sessionId, {
            prompt: responseText,
            createdAt: Date.now(),
            expiresAt: Date.now() + parseApprovalExpiryMs(responseText),
            userId,
          });
          await context.stream.finalize(
            `<@${userId}> approval required. Use \`/approve\` to view and respond privately.`,
          );
          return;
        }
        pendingApprovalBySession.delete(sessionId);
        await context.stream.finalize(responseText, attachments);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, sessionId, channelId },
          'Discord message handling failed',
        );
        const errorText = formatError('Gateway Error', text);
        await context.stream.fail(errorText);
      }
    },
    async (
      sessionId: string,
      guildId: string | null,
      channelId: string,
      userId: string,
      username: string,
      args: string[],
      reply: ReplyFn,
    ) => {
      try {
        if (
          await handleApprovalCommand({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            args,
            reply,
          })
        ) {
          return;
        }
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
        logger.error(
          { error, sessionId, channelId, args },
          'Discord command handling failed',
        );
        await reply(formatError('Gateway Error', text));
      }
    },
  );
  logger.info('Discord integration started inside gateway');
}

function setupShutdown(): void {
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down gateway...');
    if (detachConfigListener) {
      detachConfigListener();
      detachConfigListener = null;
    }
    await setDiscordMaintenancePresence().catch((error) => {
      logger.debug(
        { error },
        'Failed to set Discord maintenance presence during shutdown',
      );
    });
    stopHeartbeat();
    stopObservabilityIngest();
    stopAllExecutions();
    stopScheduler();
    stopMemoryConsolidationScheduler();
    if (proactiveFlushTimer) {
      clearInterval(proactiveFlushTimer);
      proactiveFlushTimer = null;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

async function runScheduledTask(
  request: SchedulerDispatchRequest,
): Promise<void> {
  const sourceLabel =
    request.source === 'db-task'
      ? `schedule:${request.taskId ?? 'unknown'}`
      : `schedule-job:${request.jobId ?? 'unknown'}`;
  const resolvedDeliveryChannelId =
    request.delivery.kind === 'channel'
      ? request.delivery.channelId
      : request.delivery.kind === 'last-channel'
        ? resolveLastUsedDiscordChannelId()
        : null;

  if (request.actionKind === 'system_event') {
    if (request.delivery.kind === 'webhook') {
      await deliverWebhookMessage(
        request.delivery.webhookUrl,
        request.prompt,
        `${sourceLabel}:system`,
      );
      return;
    }
    if (!resolvedDeliveryChannelId) {
      throw new Error(
        'No Discord channel available for scheduled system event delivery.',
      );
    }
    await deliverProactiveMessage(
      resolvedDeliveryChannelId,
      request.prompt,
      `${sourceLabel}:system`,
    );
    return;
  }

  const runChannelId =
    request.channelId || resolvedDeliveryChannelId || 'scheduler';
  const taskId = request.taskId ?? -1;
  const runKey =
    request.source === 'config-job'
      ? request.sessionId
      : request.taskId != null
        ? `cron:${request.taskId}`
        : undefined;

  await runGatewayScheduledTask(
    request.sessionId,
    runChannelId,
    request.prompt,
    taskId,
    async (result) => {
      if (request.delivery.kind === 'webhook') {
        await deliverWebhookMessage(
          request.delivery.webhookUrl,
          result.text,
          sourceLabel,
          result.artifacts,
        );
        logger.info(
          {
            jobId: request.jobId,
            taskId: request.taskId,
            source: request.source,
            delivery: 'webhook',
            result: result.text,
            artifactCount: result.artifacts?.length || 0,
          },
          'Scheduled task completed',
        );
        return;
      }

      if (!resolvedDeliveryChannelId) {
        throw new Error('No Discord channel available for scheduled delivery.');
      }
      await deliverProactiveMessage(
        resolvedDeliveryChannelId,
        result.text,
        sourceLabel,
        result.artifacts,
      );
      logger.info(
        {
          jobId: request.jobId,
          taskId: request.taskId,
          source: request.source,
          channelId: resolvedDeliveryChannelId,
          result: result.text,
          artifactCount: result.artifacts?.length || 0,
        },
        'Scheduled task completed',
      );
    },
    (error) => {
      logger.error(
        {
          jobId: request.jobId,
          taskId: request.taskId,
          source: request.source,
          delivery: request.delivery.kind,
          error,
        },
        'Scheduled task failed',
      );
    },
    runKey,
  );
}

function startOrRestartHeartbeat(): void {
  stopHeartbeat();
  const agentId = resolveAgentIdForModel(HYBRIDAI_MODEL, HYBRIDAI_CHATBOT_ID);
  startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
    const channelId = HEARTBEAT_CHANNEL || 'heartbeat';
    void deliverProactiveMessage(channelId, text, 'heartbeat');
    logger.info({ text }, 'Heartbeat message');
  });
}

function stopMemoryConsolidationScheduler(): void {
  if (!memoryConsolidationTimer) return;
  clearInterval(memoryConsolidationTimer);
  memoryConsolidationTimer = null;
}

function startOrRestartMemoryConsolidationScheduler(): void {
  stopMemoryConsolidationScheduler();
  const intervalHours = Math.max(
    0,
    Math.trunc(getConfigSnapshot().memory.consolidationIntervalHours),
  );
  if (intervalHours <= 0) {
    logger.info('Memory consolidation scheduler disabled');
    return;
  }

  const intervalMs = intervalHours * 3_600_000;
  memoryConsolidationTimer = setInterval(() => {
    const { decayRate } = getConfigSnapshot().memory;
    try {
      const report = memoryService.consolidateMemories({ decayRate });
      if (report.memoriesDecayed > 0) {
        logger.info(
          {
            decayed: report.memoriesDecayed,
            durationMs: report.durationMs,
            decayRate,
          },
          'Memory consolidation completed',
        );
      }
    } catch (error) {
      logger.warn({ error, decayRate }, 'Memory consolidation failed');
    }
  }, intervalMs);

  logger.info({ intervalHours }, 'Memory consolidation scheduled');
}

async function main(): Promise<void> {
  logger.info('Starting HybridClaw gateway');
  initDatabase();
  startHealthServer();
  setupShutdown();
  await startDiscordIntegration();

  startOrRestartHeartbeat();
  startObservabilityIngest();
  detachConfigListener = onConfigChange((next, prev) => {
    const shouldRestart =
      next.hybridai.defaultChatbotId !== prev.hybridai.defaultChatbotId ||
      next.heartbeat.intervalMs !== prev.heartbeat.intervalMs ||
      next.heartbeat.enabled !== prev.heartbeat.enabled;
    if (shouldRestart) {
      logger.info(
        {
          heartbeatEnabled: next.heartbeat.enabled,
          heartbeatIntervalMs: next.heartbeat.intervalMs,
          heartbeatAgentId: next.hybridai.defaultChatbotId || 'default',
        },
        'Config changed, restarting heartbeat',
      );
      startOrRestartHeartbeat();
    }

    const schedulerChanged =
      JSON.stringify(next.scheduler) !== JSON.stringify(prev.scheduler);
    if (schedulerChanged) {
      logger.info(
        'Config changed, re-arming scheduler for updated scheduler.jobs',
      );
      rearmScheduler();
    }

    const memoryChanged =
      JSON.stringify(next.memory) !== JSON.stringify(prev.memory);
    if (memoryChanged) {
      logger.info(
        {
          consolidationIntervalHours: next.memory.consolidationIntervalHours,
          decayRate: next.memory.decayRate,
        },
        'Config changed, restarting memory consolidation scheduler',
      );
      startOrRestartMemoryConsolidationScheduler();
    }

    const shouldRestartObservability =
      JSON.stringify(next.observability) !==
        JSON.stringify(prev.observability) ||
      next.hybridai.defaultChatbotId !== prev.hybridai.defaultChatbotId;
    if (!shouldRestartObservability) return;

    logger.info(
      {
        enabled: next.observability.enabled,
        botId: next.observability.botId || next.hybridai.defaultChatbotId || '',
        agentId: next.observability.agentId,
      },
      'Config changed, restarting observability ingest',
    );
    startObservabilityIngest();
  });
  startScheduler(runScheduledTask);
  startOrRestartMemoryConsolidationScheduler();
  proactiveFlushTimer = setInterval(() => {
    void flushQueuedProactiveMessages().catch((err) => {
      logger.warn({ err }, 'Failed to flush queued proactive messages');
    });
  }, 60_000);
  void flushQueuedProactiveMessages().catch((err) => {
    logger.warn({ err }, 'Initial proactive queue flush failed');
  });

  logger.info(
    { ...getGatewayStatus(), discord: !!DISCORD_TOKEN },
    'HybridClaw gateway started',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
