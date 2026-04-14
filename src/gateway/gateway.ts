import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import { resolveEffectiveTimezone } from '../../container/shared/workspace-time.js';
import {
  getActiveExecutorCount,
  stopAllExecutions,
} from '../agent/executor.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import {
  listAgents,
  resolveAgentForRequest,
} from '../agents/agent-registry.js';
import {
  startObservabilityIngest,
  stopObservabilityIngest,
} from '../audit/observability-ingest.js';
import { buildResponseText } from '../channels/discord/delivery.js';
import { rewriteUserMentionsForMessage } from '../channels/discord/mentions.js';
import {
  initDiscord,
  type ReplyFn,
  sendToChannel,
  setDiscordMaintenancePresence,
} from '../channels/discord/runtime.js';
import { buildEmailDeliveryMetadata } from '../channels/email/metadata.js';
import {
  initEmail,
  sendEmailAttachmentTo,
  sendToEmail,
  shutdownEmail,
} from '../channels/email/runtime.js';
import {
  isIMessageHandle,
  normalizeIMessageHandle,
} from '../channels/imessage/handle.js';
import {
  initIMessage,
  sendIMessageMediaToChat,
  sendToIMessageChat,
  shutdownIMessage,
} from '../channels/imessage/runtime.js';
import { buildTeamsArtifactAttachments } from '../channels/msteams/attachments.js';
import { initMSTeams } from '../channels/msteams/runtime.js';
import {
  initSlack,
  sendSlackFileToTarget,
  sendToSlackTarget,
  shutdownSlack,
} from '../channels/slack/runtime.js';
import { isSlackChannelTarget } from '../channels/slack/target.js';
import {
  hasTelegramBotToken,
  initTelegram,
  sendTelegramMediaToChat,
  sendToTelegramChat,
  shutdownTelegram,
  type TelegramReplyFn,
} from '../channels/telegram/runtime.js';
import { isTelegramChannelId } from '../channels/telegram/target.js';
import { initVoice, shutdownVoice } from '../channels/voice/runtime.js';
import {
  createVoiceTextStreamFormatter,
  normalizeVoiceUserTextForGateway,
} from '../channels/voice/text.js';
import {
  getWhatsAppAuthStatus,
  WhatsAppAuthLockError,
} from '../channels/whatsapp/auth.js';
import { isWhatsAppJid } from '../channels/whatsapp/phone.js';
import {
  initWhatsApp,
  sendToWhatsAppChat,
  sendWhatsAppMediaToChat,
  shutdownWhatsApp,
} from '../channels/whatsapp/runtime.js';
import {
  DISCORD_TOKEN,
  EMAIL_PASSWORD,
  getConfigSnapshot,
  HEARTBEAT_CHANNEL,
  HEARTBEAT_INTERVAL,
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  onConfigChange,
  PROACTIVE_QUEUE_OUTSIDE_HOURS,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  TWILIO_AUTH_TOKEN,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  deleteQueuedProactiveMessage,
  enqueueProactiveMessage,
  getMostRecentSessionChannelId,
  getQueuedProactiveMessageCount,
  initDatabase,
  listQueuedProactiveMessages,
} from '../memory/db.js';
import { memoryService } from '../memory/memory-service.js';
import { hybridAIProbe } from '../providers/hybridai-health.js';
import {
  startDiscoveryLoop,
  stopDiscoveryLoop,
} from '../providers/local-discovery.js';
import { localBackendsProbe } from '../providers/local-health.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import {
  rearmScheduler,
  type SchedulerDispatchRequest,
  startScheduler,
  stopScheduler,
} from '../scheduler/scheduler.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { formatError } from '../utils/text-format.js';
import { buildApprovalConfirmationComponents } from './approval-confirmation.js';
import {
  createApprovalPresentation,
  getApprovalPromptText,
  getApprovalVisibleText,
} from './approval-presentation.js';
import {
  DEFAULT_CHANNEL_INTERRUPTED_REPLY,
  formatChannelGatewayFailure,
} from './channel-gateway-failure.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
} from './chat-result.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { startGatewayHttpServer } from './gateway-http-server.js';
import {
  initGatewayService,
  stopGatewayPlugins,
} from './gateway-plugin-service.js';
import { runGatewayScheduledTask } from './gateway-scheduled-task-service.js';
import {
  getGatewayStatus,
  handleGatewayCommand,
  resumeEnabledFullAutoSessions,
} from './gateway-service.js';
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';
import { runManagedMediaCleanup } from './managed-media-cleanup.js';
import {
  getDreamTimezone,
  hasDreamRunToday,
  isMemoryConsolidationEnabled,
  nextDreamRunAt,
  runMemoryConsolidation,
} from './memory-consolidation-runner.js';
import {
  clearPendingApproval,
  getPendingApproval,
  rememberPendingApproval,
} from './pending-approvals.js';
import {
  hasQueuedProactiveDeliveryPath,
  isDiscordChannelId,
  isEmailAddress,
  isSupportedProactiveChannelId,
  resolveHeartbeatDeliveryChannelId,
  shouldDropQueuedProactiveMessage,
} from './proactive-delivery.js';
import {
  normalizeSessionShowMode,
  sessionShowModeShowsTools,
} from './show-mode.js';
import {
  handleTextChannelApprovalCommand,
  renderTextChannelCommandResult,
  resolveTextChannelSlashCommands,
} from './text-channel-commands.js';

let detachConfigListener: (() => void) | null = null;
let proactiveFlushTimer: ReturnType<typeof setInterval> | null = null;
let memoryConsolidationTimer: ReturnType<typeof setTimeout> | null = null;

const MAX_QUEUED_PROACTIVE_MESSAGES = 100;

function isVoiceRelayDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Voice websocket is not connected.'
  );
}

function equalStringLists(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function equalStringSets(left: string[], right: string[]): boolean {
  if (left.length === 0 && right.length === 0) return true;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== rightSet.size) return false;
  for (const entry of leftSet) {
    if (!rightSet.has(entry)) return false;
  }
  return true;
}

function hasTelegramConfigChanged(
  next: ReturnType<typeof getConfigSnapshot>['telegram'],
  prev: ReturnType<typeof getConfigSnapshot>['telegram'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.botToken !== prev.botToken ||
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringLists(next.allowFrom, prev.allowFrom) ||
    !equalStringLists(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.requireMention !== prev.requireMention ||
    next.pollIntervalMs !== prev.pollIntervalMs ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.mediaMaxMb !== prev.mediaMaxMb
  );
}

function hasSlackConfigChanged(
  next: ReturnType<typeof getConfigSnapshot>['slack'],
  prev: ReturnType<typeof getConfigSnapshot>['slack'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.dmPolicy !== prev.dmPolicy ||
    next.groupPolicy !== prev.groupPolicy ||
    !equalStringSets(next.allowFrom, prev.allowFrom) ||
    !equalStringSets(next.groupAllowFrom, prev.groupAllowFrom) ||
    next.requireMention !== prev.requireMention ||
    next.textChunkLimit !== prev.textChunkLimit ||
    next.replyStyle !== prev.replyStyle ||
    next.mediaMaxMb !== prev.mediaMaxMb
  );
}

function hasVoiceConfigChanged(
  next: ReturnType<typeof getConfigSnapshot>['voice'],
  prev: ReturnType<typeof getConfigSnapshot>['voice'],
): boolean {
  return (
    next.enabled !== prev.enabled ||
    next.provider !== prev.provider ||
    next.twilio.accountSid !== prev.twilio.accountSid ||
    next.twilio.authToken !== prev.twilio.authToken ||
    next.twilio.fromNumber !== prev.twilio.fromNumber ||
    next.relay.ttsProvider !== prev.relay.ttsProvider ||
    next.relay.voice !== prev.relay.voice ||
    next.relay.transcriptionProvider !== prev.relay.transcriptionProvider ||
    next.relay.language !== prev.relay.language ||
    next.relay.interruptible !== prev.relay.interruptible ||
    next.relay.welcomeGreeting !== prev.relay.welcomeGreeting ||
    next.webhookPath !== prev.webhookPath ||
    next.maxConcurrentCalls !== prev.maxConcurrentCalls
  );
}
const DISCORD_APPROVAL_PRESENTATION = createApprovalPresentation('buttons');
const SLACK_APPROVAL_PRESENTATION = createApprovalPresentation('buttons');
const TEAMS_APPROVAL_PRESENTATION = createApprovalPresentation('text');

function scheduleNextMemoryConsolidationRun(): void {
  if (!isMemoryConsolidationEnabled()) {
    logger.info('Memory consolidation scheduler disabled');
    return;
  }

  const nextRunAt = nextDreamRunAt();
  const delayMs = Math.max(1_000, nextRunAt.getTime() - Date.now());
  memoryConsolidationTimer = setTimeout(() => {
    memoryConsolidationTimer = null;
    void runMemoryConsolidation({
      trigger: 'nightly',
      requireSchedulerEnabled: true,
    })
      .catch(() => undefined)
      .finally(() => {
        scheduleNextMemoryConsolidationRun();
      });
  }, delayMs);

  logger.info(
    {
      nextRunAt: nextRunAt.toISOString(),
      timeZone: resolveEffectiveTimezone(getDreamTimezone()),
    },
    'Memory consolidation scheduled for next nightly run',
  );
}

function logGatewayStartup(params: {
  status: Awaited<ReturnType<typeof getGatewayStatus>>;
  channels: {
    discord: boolean;
    msteams: boolean;
    slack: boolean;
    email: boolean;
    imessage: boolean;
    telegram: boolean;
    voice: boolean;
    whatsapp: boolean;
  };
}): void {
  const {
    pid: _pid,
    timestamp: _timestamp,
    codex,
    sandbox,
    observability,
    scheduler,
    providerHealth,
    localBackends,
    pluginCommands,
    ...status
  } = params.status;

  logger.info(
    {
      ...status,
      ...(codex
        ? {
            codex: {
              authenticated: codex.authenticated,
              source: codex.source,
              reloginRequired: codex.reloginRequired,
            },
          }
        : {}),
      ...(sandbox
        ? {
            sandbox: {
              mode: sandbox.mode,
              modeExplicit: sandbox.modeExplicit,
              runningInsideContainer: sandbox.runningInsideContainer,
              activeSessions: sandbox.activeSessions,
              warning: sandbox.warning,
            },
          }
        : {}),
      ...(observability
        ? {
            observability: {
              enabled: observability.enabled,
              running: observability.running,
              paused: observability.paused,
              reason: observability.reason,
            },
          }
        : {}),
    },
    'HybridClaw gateway started',
  );

  if (scheduler?.jobs?.length) {
    logger.info({ jobs: scheduler.jobs }, 'Gateway scheduler jobs');
  }

  logger.info(
    {
      ...(providerHealth ? { providerHealth } : {}),
      ...(localBackends ? { localBackends } : {}),
    },
    'Gateway provider health',
  );

  if (pluginCommands?.length) {
    logger.info({ pluginCommands }, 'Gateway plugin commands');
  }

  logger.info(params.channels, 'Gateway channels');
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
    let mentionsArtifact = false;
    for (const hint of pathHints) {
      if (!normalizedLine.includes(hint)) continue;
      mentionsArtifact = true;
      break;
    }
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

function isLocalIMessageSelfChatContext(context: {
  inbound?: {
    backend?: string;
    isGroup?: boolean;
    handle?: string | null;
    rawEvent?: unknown;
  };
}): boolean {
  const inbound = context.inbound;
  if (!inbound || inbound.backend !== 'local' || inbound.isGroup) {
    return false;
  }
  const rawEvent =
    inbound.rawEvent && typeof inbound.rawEvent === 'object'
      ? (inbound.rawEvent as {
          handle?: string | null;
          chatIdentifier?: string | null;
        })
      : null;
  const sender = normalizeIMessageHandle(
    String(rawEvent?.handle || inbound.handle || ''),
  );
  const chatIdentifier = normalizeIMessageHandle(
    String(rawEvent?.chatIdentifier || ''),
  );
  return Boolean(sender && chatIdentifier && sender === chatIdentifier);
}

function resolveImplicitNumericApprovalArgs(params: {
  sessionId: string;
  userId: string;
  content: string;
}): string[] | null {
  const pending = getPendingApproval(params.sessionId);
  if (!pending || pending.userId !== params.userId) return null;

  const normalized = params.content.trim();
  if (normalized === '1') return ['approve', '1'];
  if (normalized === '2') return ['approve', '2'];
  if (normalized === '3') return ['approve', '3'];
  if (normalized === '4') return ['approve', '4'];
  if (normalized === '5') return ['approve', '5'];
  return null;
}

async function handleTextChannelCommand(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  args: string[];
  reply: ReplyFn;
}): Promise<void> {
  const { sessionId, guildId, channelId, userId, username, args, reply } =
    params;
  const handledApproval = await handleTextChannelApprovalCommand({
    sessionId,
    guildId,
    channelId,
    userId,
    username,
    args,
  });
  if (handledApproval) {
    if (!handledApproval.text) return;

    const components =
      handledApproval.approvalId && isDiscordChannelId(channelId)
        ? buildApprovalConfirmationComponents(handledApproval.approvalId)
        : undefined;
    if (components) {
      await reply(handledApproval.text, undefined, components);
      return;
    }

    await reply(
      handledApproval.text,
      buildArtifactAttachments(handledApproval.artifacts),
    );
    return;
  }
  const result = await handleGatewayCommand({
    sessionId,
    guildId,
    channelId,
    args,
    userId,
    username,
  });
  const text = renderTextChannelCommandResult(result);
  if (result.components !== undefined) {
    await reply(text, undefined, result.components);
    return;
  }
  await reply(text);
}

async function runTextChannelSlashCommands(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  reply: ReplyFn;
}): Promise<boolean> {
  const slashCommands = resolveTextChannelSlashCommands(params.content);
  if (!slashCommands) {
    return false;
  }

  for (const args of slashCommands) {
    await handleTextChannelCommand({
      sessionId: params.sessionId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      username: params.username,
      args,
      reply: params.reply,
    });
  }
  return true;
}

async function executeTextChannelGatewayTurn(params: {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: GatewayChatRequest['media'];
  source: string;
  reply: ReplyFn;
  abortSignal?: GatewayChatRequest['abortSignal'];
  onTextDelta?: GatewayChatRequest['onTextDelta'];
  onToolProgress?: GatewayChatRequest['onToolProgress'];
  onProactiveMessage?: GatewayChatRequest['onProactiveMessage'];
  resultTransform?: (result: GatewayChatResult) => GatewayChatResult;
}): Promise<GatewayChatResult | null> {
  const normalizedContent =
    params.source === 'voice'
      ? normalizeVoiceUserTextForGateway(params.content)
      : params.content;
  const handledSlashCommands = await runTextChannelSlashCommands({
    sessionId: params.sessionId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    username: params.username,
    content: normalizedContent,
    reply: params.reply,
  });
  if (handledSlashCommands) {
    return null;
  }

  const result = normalizePlaceholderToolReply(
    await handleGatewayMessage({
      sessionId: params.sessionId,
      guildId: params.guildId,
      channelId: params.channelId,
      userId: params.userId,
      username: params.username,
      content: normalizedContent,
      media: params.media,
      abortSignal: params.abortSignal,
      onTextDelta: params.onTextDelta,
      onToolProgress: params.onToolProgress,
      onProactiveMessage: params.onProactiveMessage,
      source: params.source,
    }),
  );
  return params.resultTransform ? params.resultTransform(result) : result;
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
  if (isWhatsAppJid(channelId)) {
    const whatsappAuth = await getWhatsAppAuthStatus();
    if (!whatsappAuth.linked) {
      logger.info(
        { source, channelId, text },
        'Proactive WhatsApp message suppressed: WhatsApp not linked',
      );
      return;
    }
    if (attachments.length > 0) {
      logger.warn(
        { source, channelId, artifactCount: attachments.length },
        'Proactive WhatsApp delivery currently sends text only',
      );
    }
    try {
      await sendToWhatsAppChat(channelId, text);
    } catch (error) {
      logger.warn(
        { source, channelId, error },
        'Failed to send proactive message to WhatsApp chat',
      );
      logger.info({ source, channelId, text }, 'Proactive message fallback');
    }
    return;
  }

  if (isIMessageHandle(channelId)) {
    if (!getConfigSnapshot().imessage.enabled) {
      logger.info(
        { source, channelId, text, artifactCount: attachments.length },
        'Proactive iMessage message suppressed: iMessage channel is not configured',
      );
      return;
    }
    try {
      if (artifacts && artifacts.length > 0) {
        await sendIMessageMediaToChat({
          target: channelId,
          filePath: artifacts[0].path,
          mimeType: artifacts[0].mimeType,
          filename: artifacts[0].filename,
          caption: text,
        });
        for (let index = 1; index < artifacts.length; index += 1) {
          await sendIMessageMediaToChat({
            target: channelId,
            filePath: artifacts[index].path,
            mimeType: artifacts[index].mimeType,
            filename: artifacts[index].filename,
          });
        }
        return;
      }

      await sendToIMessageChat(channelId, text);
    } catch (error) {
      logger.warn(
        { source, channelId, error, artifactCount: attachments.length },
        'Failed to send proactive message to iMessage chat',
      );
      logger.info({ source, channelId, text }, 'Proactive message fallback');
    }
    return;
  }

  if (isEmailAddress(channelId)) {
    if (
      !getConfigSnapshot().email.enabled ||
      !String(EMAIL_PASSWORD || '').trim()
    ) {
      logger.info(
        { source, channelId, text, artifactCount: attachments.length },
        'Proactive email message suppressed: email channel is not configured',
      );
      return;
    }

    try {
      if (artifacts && artifacts.length > 0) {
        await sendEmailAttachmentTo({
          to: channelId,
          filePath: artifacts[0].path,
          body: text,
          mimeType: artifacts[0].mimeType,
          filename: artifacts[0].filename,
        });
        for (let index = 1; index < artifacts.length; index += 1) {
          await sendEmailAttachmentTo({
            to: channelId,
            filePath: artifacts[index].path,
            mimeType: artifacts[index].mimeType,
            filename: artifacts[index].filename,
          });
        }
        return;
      }

      await sendToEmail(channelId, text);
    } catch (error) {
      logger.warn(
        { source, channelId, error, artifactCount: attachments.length },
        'Failed to send proactive message to email recipient',
      );
      logger.info({ source, channelId, text }, 'Proactive message fallback');
    }
    return;
  }

  if (isSlackChannelTarget(channelId)) {
    const slackConfigured =
      getConfigSnapshot().slack.enabled &&
      Boolean(trimValue(SLACK_BOT_TOKEN)) &&
      Boolean(trimValue(SLACK_APP_TOKEN));
    if (!slackConfigured) {
      logger.info(
        { source, channelId, text, artifactCount: attachments.length },
        'Proactive Slack message suppressed: Slack is not configured',
      );
      return;
    }

    try {
      if (text.trim()) {
        await sendToSlackTarget(channelId, text);
      }
      for (const artifact of artifacts || []) {
        await sendSlackFileToTarget({
          target: channelId,
          filePath: artifact.path,
          filename: artifact.filename,
        });
      }
      return;
    } catch (error) {
      logger.warn(
        { source, channelId, error, artifactCount: attachments.length },
        'Failed to send proactive message to Slack conversation',
      );
      logger.info({ source, channelId, text }, 'Proactive message fallback');
    }
    return;
  }

  if (isTelegramChannelId(channelId)) {
    const telegramConfig = getConfigSnapshot().telegram;
    const hasBotToken = hasTelegramBotToken();
    if (!telegramConfig.enabled || !hasBotToken) {
      logger.info(
        { source, channelId, text, artifactCount: attachments.length },
        'Proactive Telegram message suppressed: Telegram channel is not configured',
      );
      return;
    }

    try {
      if (text.trim()) {
        await sendToTelegramChat(channelId, text);
      }
      for (const artifact of artifacts || []) {
        await sendTelegramMediaToChat({
          target: channelId,
          filePath: artifact.path,
          mimeType: artifact.mimeType,
          filename: artifact.filename,
        });
      }
      return;
    } catch (error) {
      logger.warn(
        { source, channelId, error, artifactCount: attachments.length },
        'Failed to send proactive message to Telegram chat',
      );
      logger.info({ source, channelId, text }, 'Proactive message fallback');
    }
    return;
  }

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

function resolveLastUsedDeliverableChannelId(): string | null {
  const channelId = getMostRecentSessionChannelId();
  if (!channelId) return null;
  return hasQueuedProactiveDeliveryPath({ channel_id: channelId })
    ? channelId
    : null;
}

async function flushQueuedProactiveMessages(): Promise<void> {
  if (!isWithinActiveHours()) return;
  const pending = listQueuedProactiveMessages(MAX_QUEUED_PROACTIVE_MESSAGES);
  if (pending.length === 0) return;
  logger.info(
    { flushing: pending.length, queued: getQueuedProactiveMessageCount() },
    'Flushing queued proactive messages',
  );

  let droppedUndeliverable = 0;
  for (const item of pending) {
    if (!isWithinActiveHours()) break;
    if (!isSupportedProactiveChannelId(item.channel_id)) {
      if (shouldDropQueuedProactiveMessage(item)) {
        deleteQueuedProactiveMessage(item.id);
        droppedUndeliverable += 1;
      }
      continue;
    }
    await sendProactiveMessageNow(
      item.channel_id,
      item.text,
      `${item.source}:queued`,
    );
    deleteQueuedProactiveMessage(item.id);
  }

  if (droppedUndeliverable > 0) {
    logger.info(
      { dropped: droppedUndeliverable },
      'Dropped undeliverable queued proactive messages',
    );
  }
}

async function startDiscordIntegration(): Promise<boolean> {
  if (!String(DISCORD_TOKEN || '').trim()) {
    logger.info('DISCORD_TOKEN not set; Discord integration disabled');
    return false;
  }

  try {
    await initDiscord(
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
            if (!sawTextDelta) sawTextDelta = true;
            await context.stream.append(text);
          };
          const result = normalizePendingApprovalReply(
            normalizePlaceholderToolReply(
              await handleGatewayMessage({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                content,
                media,
                source: 'discord',
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
              }),
            ),
          );
          if (result.status === 'error') {
            const errorText = formatError(
              'Agent Error',
              result.error || 'Unknown error',
            );
            await context.stream.fail(errorText);
            return;
          }
          const pendingApproval = extractGatewayChatApprovalEvent(result);
          const effectiveSessionId = result.sessionId || sessionId;
          if (!pendingApproval) {
            const bufferedDelta = streamFilter.flush();
            if (bufferedDelta) {
              await appendStreamText(bufferedDelta);
            }
          }
          if (streamFilter.isSilent() || isSilentReply(result.result)) {
            await clearPendingApproval(effectiveSessionId, {
              disableButtons: true,
            });
            await context.stream.discard();
            return;
          }
          const rawText = stripSilentToken(String(result.result));
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          const userText = simplifyImageAttachmentNarration(
            rawText,
            result.artifacts,
          );
          const renderedText = await rewriteUserMentionsForMessage(
            userText,
            context.sourceMessage,
            context.mentionLookup,
          );
          const responseText = buildResponseText(
            renderedText,
            sessionShowModeShowsTools(showMode) ? result.toolsUsed : undefined,
            result.memoryCitations,
          );
          if (pendingApproval) {
            const storedPrompt = getApprovalPromptText(
              pendingApproval,
              responseText,
            );
            const approvalPresentation = context.sendApprovalNotification
              ? DISCORD_APPROVAL_PRESENTATION
              : createApprovalPresentation('text');
            let cleanup: { disableButtons: () => Promise<void> } | null = null;
            if (context.sendApprovalNotification) {
              cleanup = await context.sendApprovalNotification({
                approval: pendingApproval,
                presentation: approvalPresentation,
                userId,
              });
            } else {
              await context.stream.finalize(`<@${userId}> ${storedPrompt}`);
            }
            await rememberPendingApproval({
              sessionId: effectiveSessionId,
              approvalId: pendingApproval.approvalId,
              prompt: storedPrompt,
              userId,
              expiresAt: pendingApproval.expiresAt,
              presentation: approvalPresentation,
              disableButtons: cleanup?.disableButtons ?? null,
            });
            if (cleanup) {
              await context.stream.discard();
            }
            return;
          }
          const attachments = buildArtifactAttachments(result.artifacts);
          if (!rawText.trim()) {
            await clearPendingApproval(effectiveSessionId, {
              disableButtons: true,
            });
            await context.stream.discard();
            return;
          }
          await clearPendingApproval(effectiveSessionId, {
            disableButtons: true,
          });
          if (result.components && !sawTextDelta) {
            await _reply(responseText, attachments, result.components);
            await context.stream.discard();
            return;
          }
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
          await handleTextChannelCommand({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            args,
            reply,
          });
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
  } catch (error) {
    if (isDiscordInvalidTokenError(error)) {
      logger.warn(
        'Discord integration disabled: DISCORD_TOKEN was rejected by Discord. Update or clear the token and restart the gateway.',
      );
      return false;
    }
    logger.error({ error }, 'Discord integration failed to start');
    return false;
  }
  logger.info('Discord integration started inside gateway');
  return true;
}

function isDiscordInvalidTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code =
    'code' in error && typeof error.code === 'string' ? error.code : '';
  if (code === 'TokenInvalid') return true;
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : '';
  return message.toLowerCase().includes('invalid token');
}

function isWhatsAppAuthLockError(
  error: unknown,
): error is WhatsAppAuthLockError {
  return error instanceof WhatsAppAuthLockError;
}

async function startMSTeamsIntegration(): Promise<boolean> {
  const teamsConfig = getConfigSnapshot().msteams;
  const hasCredentials =
    Boolean(String(MSTEAMS_APP_ID || '').trim()) &&
    Boolean(String(MSTEAMS_APP_PASSWORD || '').trim());

  if (!teamsConfig.enabled) {
    logger.info('Microsoft Teams integration disabled');
    return false;
  }
  if (!hasCredentials) {
    logger.info(
      'Microsoft Teams integration disabled: MSTEAMS_APP_ID or MSTEAMS_APP_PASSWORD is missing',
    );
    return false;
  }
  if (teamsConfig.webhook.port !== getConfigSnapshot().ops.healthPort) {
    logger.info(
      {
        configuredWebhookPort: teamsConfig.webhook.port,
        gatewayPort: getConfigSnapshot().ops.healthPort,
        webhookPath: teamsConfig.webhook.path,
      },
      'Microsoft Teams webhook uses the shared gateway HTTP port; configured webhook.port is informational only',
    );
  }

  initMSTeams(
    async (
      sessionId,
      guildId,
      channelId,
      userId,
      username,
      content,
      media,
      reply,
      context,
    ) => {
      try {
        const implicitApprovalArgs = resolveImplicitNumericApprovalArgs({
          sessionId,
          userId,
          content,
        });
        if (implicitApprovalArgs) {
          const bridgedReply: ReplyFn = async (content) => {
            await reply(content);
          };
          await handleTextChannelCommand({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            args: implicitApprovalArgs,
            reply: bridgedReply,
          });
          return;
        }

        let sawTextDelta = false;
        const streamFilter = createSilentReplyStreamFilter();
        const appendStreamText = async (text: string): Promise<void> => {
          if (!text) return;
          if (!sawTextDelta) sawTextDelta = true;
          await context.stream.append(text);
        };
        const result = normalizePendingApprovalReply(
          normalizePlaceholderToolReply(
            await handleGatewayMessage({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              source: 'msteams',
              onTextDelta: (delta) => {
                const filteredDelta = streamFilter.push(delta);
                if (!filteredDelta) return;
                void appendStreamText(filteredDelta);
              },
              abortSignal: context.abortSignal,
            }),
          ),
        );
        if (result.status === 'error') {
          await context.stream.fail(
            formatError('Agent Error', result.error || 'Unknown error'),
          );
          return;
        }

        const bufferedDelta = streamFilter.flush();
        if (bufferedDelta) {
          await appendStreamText(bufferedDelta);
        }
        if (streamFilter.isSilent() || isSilentReply(result.result)) {
          await context.stream.discard();
          return;
        }

        const renderedText = stripSilentToken(String(result.result || ''));
        const artifacts = result.artifacts || [];
        const effectiveSessionId = result.sessionId || sessionId;
        if (!renderedText.trim() && artifacts.length === 0) {
          await context.stream.discard();
          return;
        }
        const showMode = normalizeSessionShowMode(
          memoryService.getSessionById(effectiveSessionId)?.show_mode,
        );
        const responseText = renderedText.trim()
          ? buildResponseText(
              renderedText,
              sessionShowModeShowsTools(showMode)
                ? result.toolsUsed
                : undefined,
            )
          : '';
        const pendingApproval = extractGatewayChatApprovalEvent(result);
        if (pendingApproval) {
          const storedPrompt = getApprovalPromptText(
            pendingApproval,
            responseText,
          );
          const visiblePrompt = getApprovalVisibleText(
            pendingApproval,
            TEAMS_APPROVAL_PRESENTATION,
            responseText,
          );
          await rememberPendingApproval({
            sessionId: effectiveSessionId,
            approvalId: pendingApproval.approvalId,
            prompt: storedPrompt,
            userId,
            expiresAt: pendingApproval.expiresAt,
            presentation: TEAMS_APPROVAL_PRESENTATION,
          });
          await context.stream.finalize(
            `${visiblePrompt}\n\nApproval required. Reply \`1\` to allow once, \`2\` to allow for this session, \`3\` to allow for this agent, \`4\` to allow for all, or \`5\` to deny. You can also use \`/approve view\` or \`/approve [1|2|3|4|5]\`.`,
          );
          return;
        }

        let attachments:
          | Awaited<ReturnType<typeof buildTeamsArtifactAttachments>>
          | undefined;
        try {
          attachments = await buildTeamsArtifactAttachments({
            turnContext: context.turnContext,
            artifacts,
          });
        } catch (error) {
          logger.warn(
            {
              error,
              sessionId,
              channelId,
              artifactCount: artifacts.length,
            },
            'Failed to build Teams artifact attachments',
          );
        }

        if (attachments?.length && sawTextDelta) {
          await context.stream.finalize(responseText);
          await reply('', attachments);
          return;
        }
        await context.stream.finalize(responseText, attachments);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, sessionId, channelId },
          'Teams message handling failed',
        );
        await context.stream.fail(formatError('Gateway Error', text));
      }
    },
    async (sessionId, guildId, channelId, userId, username, args, reply) => {
      try {
        const bridgedReply: ReplyFn = async (content) => {
          await reply(content);
        };
        await handleTextChannelCommand({
          sessionId,
          guildId,
          channelId,
          userId,
          username,
          args,
          reply: bridgedReply,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        logger.error(
          { error, sessionId, channelId, args },
          'Teams command handling failed',
        );
        await reply(formatError('Gateway Error', text));
      }
    },
  );
  logger.info(
    {
      webhookPath: teamsConfig.webhook.path,
      autoStartedFromEnv: false,
    },
    'Microsoft Teams integration started inside gateway',
  );
  return true;
}

async function startWhatsAppIntegration(): Promise<boolean> {
  const whatsappConfig = getConfigSnapshot().whatsapp;
  const transportEnabled =
    whatsappConfig.dmPolicy !== 'disabled' ||
    whatsappConfig.groupPolicy !== 'disabled';
  if (!transportEnabled) {
    logger.info('WhatsApp integration disabled: transport is off');
    return false;
  }

  const whatsappAuth = await getWhatsAppAuthStatus();
  if (!whatsappAuth.linked) {
    logger.info(
      'WhatsApp integration starting in pairing mode: no linked auth state found',
    );
  }

  try {
    await initWhatsApp(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        try {
          const slashCommands = resolveTextChannelSlashCommands(content);
          if (slashCommands) {
            const textReply: ReplyFn = async (message) => {
              await reply(message);
            };
            for (const args of slashCommands) {
              await handleTextChannelCommand({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                args,
                reply: textReply,
              });
            }
            return;
          }

          const result = normalizePlaceholderToolReply(
            await handleGatewayMessage({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              onProactiveMessage: async (message) => {
                await deliverProactiveMessage(
                  channelId,
                  message.text,
                  'delegate',
                  message.artifacts,
                );
              },
              abortSignal: context.abortSignal,
              source: 'whatsapp',
            }),
          );
          if (result.status === 'error') {
            await reply(formatChannelGatewayFailure(result.error));
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          const artifacts = result.artifacts || [];
          if (isSilentReply(result.result)) {
            return;
          }
          if (!cleanedResultText.trim() && artifacts.length === 0) {
            return;
          }

          const effectiveSessionId = result.sessionId || sessionId;
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          if (cleanedResultText.trim()) {
            const responseText = buildResponseText(
              cleanedResultText,
              sessionShowModeShowsTools(showMode)
                ? result.toolsUsed
                : undefined,
            );
            await reply(responseText);
          }
          for (const artifact of artifacts) {
            try {
              await sendWhatsAppMediaToChat({
                jid: channelId,
                filePath: artifact.path,
                mimeType: artifact.mimeType,
                filename: artifact.filename,
              });
            } catch (error) {
              logger.warn(
                { error, channelId, artifactPath: artifact.path },
                'Failed to send WhatsApp artifact',
              );
            }
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId },
            'WhatsApp message handling failed',
          );
          await reply(formatChannelGatewayFailure(text));
        }
      },
    );
  } catch (error) {
    if (isWhatsAppAuthLockError(error)) {
      logger.warn(
        {
          lockPath: error.lockPath,
          ownerPid: error.ownerPid ?? null,
        },
        'WhatsApp integration disabled: auth state is locked by another HybridClaw process',
      );
      return false;
    }
    logger.error({ error }, 'WhatsApp integration failed to start');
    return false;
  }
  logger.info(
    whatsappAuth.linked
      ? 'WhatsApp integration started inside gateway'
      : 'WhatsApp integration started in pairing mode inside gateway',
  );
  return true;
}

async function startEmailIntegration(): Promise<boolean> {
  const emailConfig = getConfigSnapshot().email;
  if (!emailConfig.enabled) {
    logger.info('Email integration disabled: email.enabled=false');
    return false;
  }
  if (!emailConfig.address.trim()) {
    logger.info('Email integration disabled: no email address configured');
    return false;
  }
  if (!emailConfig.imapHost.trim() || !emailConfig.smtpHost.trim()) {
    logger.info(
      'Email integration disabled: IMAP/SMTP host configuration incomplete',
    );
    return false;
  }
  if (!String(EMAIL_PASSWORD || '').trim()) {
    logger.info('Email integration disabled: EMAIL_PASSWORD not configured');
    return false;
  }

  try {
    await initEmail(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        try {
          const slashCommands = resolveTextChannelSlashCommands(content);
          if (slashCommands) {
            const textReply: ReplyFn = async (message) => {
              await reply(message);
            };
            for (const args of slashCommands) {
              await handleTextChannelCommand({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                args,
                reply: textReply,
              });
            }
            return;
          }

          const result = normalizePlaceholderToolReply(
            await handleGatewayMessage({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              onProactiveMessage: async (message) => {
                await deliverProactiveMessage(
                  channelId,
                  message.text,
                  'delegate',
                  message.artifacts,
                );
              },
              abortSignal: context.abortSignal,
              source: 'email',
            }),
          );
          if (result.status === 'error') {
            await reply(formatChannelGatewayFailure(result.error));
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          const artifacts = result.artifacts || [];
          if (isSilentReply(result.result)) {
            return;
          }
          if (!cleanedResultText.trim() && artifacts.length === 0) {
            return;
          }

          const effectiveSessionId = result.sessionId || sessionId;
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          const emailMetadata = buildEmailDeliveryMetadata({
            agentId: result.agentId,
            model: result.model,
            provider: result.provider,
            tokenUsage: result.tokenUsage,
          });
          if (cleanedResultText.trim()) {
            const responseText = buildResponseText(
              cleanedResultText,
              sessionShowModeShowsTools(showMode)
                ? result.toolsUsed
                : undefined,
            );
            await sendToEmail(channelId, responseText, {
              ...(emailMetadata ? { metadata: emailMetadata } : {}),
            });
          }
          for (const artifact of artifacts) {
            try {
              await sendEmailAttachmentTo({
                to: channelId,
                filePath: artifact.path,
                mimeType: artifact.mimeType,
                filename: artifact.filename,
                ...(emailMetadata ? { metadata: emailMetadata } : {}),
              });
            } catch (error) {
              logger.warn(
                { error, channelId, artifactPath: artifact.path },
                'Failed to send email artifact',
              );
            }
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId },
            'Email message handling failed',
          );
          await reply(formatChannelGatewayFailure(text));
        }
      },
    );
  } catch (error) {
    logger.warn({ error }, 'Email integration failed to start');
    return false;
  }

  logger.info('Email integration started inside gateway');
  return true;
}

async function startTelegramIntegration(): Promise<boolean> {
  const telegramConfig = getConfigSnapshot().telegram;
  const hasInboundPolicy =
    telegramConfig.dmPolicy !== 'disabled' ||
    telegramConfig.groupPolicy !== 'disabled';
  const hasBotToken = hasTelegramBotToken();

  if (!telegramConfig.enabled) {
    logger.info('Telegram integration disabled: telegram.enabled=false');
    return false;
  }
  if (!hasInboundPolicy) {
    logger.info('Telegram integration disabled: transport is off');
    return false;
  }
  if (!hasBotToken) {
    logger.info(
      'Telegram integration disabled: TELEGRAM_BOT_TOKEN is not configured',
    );
    return false;
  }

  try {
    await initTelegram(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply: TelegramReplyFn,
        context,
      ) => {
        try {
          const implicitApprovalArgs = resolveImplicitNumericApprovalArgs({
            sessionId,
            userId,
            content,
          });
          if (implicitApprovalArgs) {
            const bridgedReply: ReplyFn = async (message) => {
              await reply(message);
            };
            await handleTextChannelCommand({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              args: implicitApprovalArgs,
              reply: bridgedReply,
            });
            return;
          }

          const slashCommands = resolveTextChannelSlashCommands(content);
          if (slashCommands) {
            const bridgedReply: ReplyFn = async (message) => {
              await reply(message);
            };
            for (const args of slashCommands) {
              await handleTextChannelCommand({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                args,
                reply: bridgedReply,
              });
            }
            return;
          }

          const result = normalizePlaceholderToolReply(
            await handleGatewayMessage({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              onProactiveMessage: async (message) => {
                await deliverProactiveMessage(
                  channelId,
                  message.text,
                  'delegate',
                  message.artifacts,
                );
              },
              abortSignal: context.abortSignal,
              source: 'telegram',
            }),
          );
          if (result.status === 'error') {
            await reply(formatChannelGatewayFailure(result.error));
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          const artifacts = result.artifacts || [];
          if (isSilentReply(result.result)) {
            return;
          }
          if (!cleanedResultText.trim() && artifacts.length === 0) {
            return;
          }

          const effectiveSessionId = result.sessionId || sessionId;
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          if (cleanedResultText.trim()) {
            const responseText = buildResponseText(
              cleanedResultText,
              sessionShowModeShowsTools(showMode)
                ? result.toolsUsed
                : undefined,
            );
            await reply(responseText);
          }
          for (const artifact of artifacts) {
            try {
              await sendTelegramMediaToChat({
                target: channelId,
                filePath: artifact.path,
                mimeType: artifact.mimeType,
                filename: artifact.filename,
              });
            } catch (error) {
              logger.warn(
                { error, channelId, artifactPath: artifact.path },
                'Failed to send Telegram artifact',
              );
            }
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId },
            'Telegram message handling failed',
          );
          await reply(formatChannelGatewayFailure(text));
        }
      },
    );
  } catch (error) {
    logger.warn({ error }, 'Telegram integration failed to start');
    return false;
  }

  logger.info('Telegram integration started inside gateway');
  return true;
}

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

async function startSlackIntegration(): Promise<boolean> {
  const slackConfig = getConfigSnapshot().slack;
  const hasCredentials =
    Boolean(trimValue(SLACK_BOT_TOKEN)) && Boolean(trimValue(SLACK_APP_TOKEN));

  if (!slackConfig.enabled) {
    logger.info('Slack integration disabled');
    return false;
  }
  if (!hasCredentials) {
    logger.info(
      'Slack integration disabled: SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing',
    );
    return false;
  }

  try {
    await initSlack(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        try {
          const textReply: ReplyFn = async (message) => {
            await reply(message);
          };
          let sawTextDelta = false;
          const result = await executeTextChannelGatewayTurn({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            content,
            media,
            source: 'slack',
            reply: textReply,
            onProactiveMessage: async (message) => {
              await deliverProactiveMessage(
                channelId,
                message.text,
                'delegate',
                message.artifacts,
              );
            },
            onTextDelta: (delta) => {
              if (!delta || sawTextDelta) return;
              sawTextDelta = true;
              context.emitLifecyclePhase?.('streaming');
            },
            onToolProgress: (event) => {
              if (sawTextDelta) return;
              if (event.phase === 'start') {
                context.emitLifecyclePhase?.('toolUse');
              } else {
                context.emitLifecyclePhase?.('thinking');
              }
            },
          });
          if (!result) {
            return;
          }
          if (result.status === 'error') {
            await reply(
              formatError('Agent Error', result.error || 'Unknown error'),
            );
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          const artifacts = result.artifacts || [];
          if (isSilentReply(result.result)) {
            return;
          }
          if (!cleanedResultText.trim() && artifacts.length === 0) {
            return;
          }

          const effectiveSessionId = result.sessionId || sessionId;
          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(effectiveSessionId)?.show_mode,
          );
          const pendingApproval = extractGatewayChatApprovalEvent(result);
          const responseText = cleanedResultText.trim()
            ? buildResponseText(
                cleanedResultText,
                sessionShowModeShowsTools(showMode)
                  ? result.toolsUsed
                  : undefined,
              )
            : '';
          if (pendingApproval) {
            const storedPrompt = getApprovalPromptText(
              pendingApproval,
              responseText,
            );
            const approvalPresentation = context.sendApprovalNotification
              ? SLACK_APPROVAL_PRESENTATION
              : createApprovalPresentation('text');
            let cleanup: { disableButtons: () => Promise<void> } | null = null;
            if (context.sendApprovalNotification) {
              cleanup = await context.sendApprovalNotification({
                approval: pendingApproval,
                presentation: approvalPresentation,
                userId,
              });
            } else {
              await reply(storedPrompt);
            }
            await rememberPendingApproval({
              sessionId: effectiveSessionId,
              approvalId: pendingApproval.approvalId,
              prompt: storedPrompt,
              userId,
              expiresAt: pendingApproval.expiresAt,
              presentation: approvalPresentation,
              disableButtons: cleanup?.disableButtons ?? null,
            });
            return;
          }
          if (responseText) {
            await reply(responseText);
          }
          for (const artifact of artifacts) {
            await sendSlackFileToTarget({
              target: context.inbound.target,
              filePath: artifact.path,
              filename: artifact.filename,
            });
          }
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId },
            'Slack message handling failed',
          );
          await reply(formatError('Gateway Error', text));
        }
      },
      async (sessionId, guildId, channelId, userId, username, args, reply) => {
        try {
          await handleTextChannelCommand({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            args,
            reply,
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId, args },
            'Slack command handling failed',
          );
          await reply(formatError('Gateway Error', text));
        }
      },
    );
  } catch (error) {
    logger.error({ error }, 'Slack integration failed to start');
    return false;
  }

  logger.info('Slack integration started inside gateway');
  return true;
}

async function refreshEmailIntegrationForConfigChange(
  next: ReturnType<typeof getConfigSnapshot>,
  prev: ReturnType<typeof getConfigSnapshot>,
): Promise<void> {
  if (JSON.stringify(next.email) === JSON.stringify(prev.email)) return;

  logger.info(
    {
      enabled: next.email.enabled,
      address: next.email.address,
      smtpHost: next.email.smtpHost,
      smtpPort: next.email.smtpPort,
      smtpSecure: next.email.smtpSecure,
    },
    'Config changed, restarting email integration',
  );
  await shutdownEmail().catch((error) => {
    logger.debug(
      { error },
      'Failed to stop email runtime during config-change restart',
    );
  });
  await startEmailIntegration();
}

async function refreshTelegramIntegrationForConfigChange(
  next: ReturnType<typeof getConfigSnapshot>,
  prev: ReturnType<typeof getConfigSnapshot>,
): Promise<void> {
  if (!hasTelegramConfigChanged(next.telegram, prev.telegram)) return;

  logger.info(
    {
      enabled: next.telegram.enabled,
      dmPolicy: next.telegram.dmPolicy,
      groupPolicy: next.telegram.groupPolicy,
      pollIntervalMs: next.telegram.pollIntervalMs,
      requireMention: next.telegram.requireMention,
    },
    'Config changed, restarting Telegram integration',
  );
  await shutdownTelegram().catch((error) => {
    logger.debug(
      { error },
      'Failed to stop Telegram runtime during config-change restart',
    );
  });
  await startTelegramIntegration();
}

async function refreshSlackIntegrationForConfigChange(
  next: ReturnType<typeof getConfigSnapshot>,
  prev: ReturnType<typeof getConfigSnapshot>,
): Promise<void> {
  if (!hasSlackConfigChanged(next.slack, prev.slack)) return;

  logger.info(
    {
      enabled: next.slack.enabled,
      dmPolicy: next.slack.dmPolicy,
      groupPolicy: next.slack.groupPolicy,
      requireMention: next.slack.requireMention,
      replyStyle: next.slack.replyStyle,
    },
    'Config changed, restarting Slack integration',
  );
  await shutdownSlack().catch((error) => {
    logger.debug(
      { error },
      'Failed to stop Slack runtime during config-change restart',
    );
  });
  await startSlackIntegration();
}

async function startVoiceIntegration(): Promise<boolean> {
  const voiceConfig = getConfigSnapshot().voice;
  const twilioAuthToken = String(TWILIO_AUTH_TOKEN || '').trim();
  if (!voiceConfig.enabled) {
    logger.info('Voice integration disabled in config');
    return false;
  }
  if (
    !voiceConfig.twilio.accountSid.trim() ||
    !twilioAuthToken ||
    !voiceConfig.twilio.fromNumber.trim()
  ) {
    logger.warn(
      {
        accountSidConfigured: Boolean(voiceConfig.twilio.accountSid.trim()),
        authTokenConfigured: Boolean(twilioAuthToken),
        fromNumberConfigured: Boolean(voiceConfig.twilio.fromNumber.trim()),
      },
      'Voice integration disabled: Twilio credentials are incomplete',
    );
    return false;
  }

  try {
    await initVoice(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        try {
          const textReply: ReplyFn = async (message) => {
            await reply(message);
          };
          let sawTextDelta = false;
          const streamFilter = createSilentReplyStreamFilter();
          const voiceTextStream = createVoiceTextStreamFormatter();
          const result = await executeTextChannelGatewayTurn({
            sessionId,
            guildId,
            channelId,
            userId,
            username,
            content,
            media,
            source: 'voice',
            reply: textReply,
            abortSignal: context.abortSignal,
            onTextDelta: (delta) => {
              const filteredDelta = streamFilter.push(delta);
              if (!filteredDelta) return;
              for (const voiceDelta of voiceTextStream.push(filteredDelta)) {
                sawTextDelta = true;
                void context.responseStream.push(voiceDelta).catch((error) => {
                  if (
                    context.abortSignal.aborted ||
                    isVoiceRelayDisconnectedError(error)
                  ) {
                    return;
                  }
                  logger.debug(
                    { error, callSid: context.callSid, channelId },
                    'Voice text delta streaming failed',
                  );
                });
              }
            },
            onProactiveMessage: async (message) => {
              logger.debug(
                {
                  callSid: context.callSid,
                  artifactCount: message.artifacts?.length || 0,
                },
                'Skipping proactive voice follow-up',
              );
            },
            resultTransform: (result) => normalizePendingApprovalReply(result),
          });
          if (!result) {
            return;
          }
          if (result.status === 'error') {
            await reply(formatChannelGatewayFailure(result.error));
            return;
          }

          const trailingDelta = streamFilter.flush();
          if (trailingDelta) {
            for (const voiceDelta of voiceTextStream.push(trailingDelta)) {
              sawTextDelta = true;
              await context.responseStream.push(voiceDelta).catch((error) => {
                if (
                  context.abortSignal.aborted ||
                  isVoiceRelayDisconnectedError(error)
                ) {
                  return;
                }
                throw error;
              });
            }
          }

          for (const voiceDelta of voiceTextStream.flush()) {
            sawTextDelta = true;
            await context.responseStream.push(voiceDelta).catch((error) => {
              if (
                context.abortSignal.aborted ||
                isVoiceRelayDisconnectedError(error)
              ) {
                return;
              }
              throw error;
            });
          }

          if (isSilentReply(result.result)) {
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          if (!sawTextDelta && cleanedResultText.trim()) {
            await reply(cleanedResultText);
          }
        } catch (error) {
          if (
            context.abortSignal.aborted ||
            isVoiceRelayDisconnectedError(error)
          ) {
            logger.debug(
              { sessionId, channelId, callSid: context.callSid },
              'Voice message handling aborted after relay disconnect',
            );
            return;
          }
          logger.error(
            { error, sessionId, channelId, callSid: context.callSid },
            'Voice message handling failed',
          );
          try {
            await reply(formatChannelGatewayFailure('Response interrupted.'));
          } catch (replyError) {
            if (
              !context.abortSignal.aborted &&
              !isVoiceRelayDisconnectedError(replyError)
            ) {
              throw replyError;
            }
          }
        }
      },
    );
    logger.info(
      {
        provider: voiceConfig.provider,
        webhookPath: voiceConfig.webhookPath,
        maxConcurrentCalls: voiceConfig.maxConcurrentCalls,
      },
      'Voice integration started inside gateway',
    );
    return true;
  } catch (error) {
    logger.warn({ error }, 'Voice integration failed to start');
    return false;
  }
}

async function refreshVoiceIntegrationForConfigChange(
  next: ReturnType<typeof getConfigSnapshot>,
  prev: ReturnType<typeof getConfigSnapshot>,
): Promise<void> {
  if (!hasVoiceConfigChanged(next.voice, prev.voice)) return;

  logger.info(
    {
      enabled: next.voice.enabled,
      provider: next.voice.provider,
      webhookPath: next.voice.webhookPath,
      maxConcurrentCalls: next.voice.maxConcurrentCalls,
    },
    'Config changed, restarting Voice integration',
  );
  await shutdownVoice().catch((error) => {
    logger.debug(
      { error },
      'Failed to stop Voice runtime during config-change restart',
    );
  });
  await startVoiceIntegration();
}

async function startIMessageIntegration(): Promise<boolean> {
  const imessageConfig = getConfigSnapshot().imessage;
  if (!imessageConfig.enabled) {
    logger.info('iMessage integration disabled in config');
    return false;
  }

  try {
    await initIMessage(
      async (
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      ) => {
        try {
          const slashCommands = resolveTextChannelSlashCommands(content);
          if (slashCommands) {
            const textReply: ReplyFn = async (message) => {
              await reply(message);
            };
            for (const args of slashCommands) {
              await handleTextChannelCommand({
                sessionId,
                guildId,
                channelId,
                userId,
                username,
                args,
                reply: textReply,
              });
            }
            return;
          }

          const result = normalizePlaceholderToolReply(
            await handleGatewayMessage({
              sessionId,
              guildId,
              channelId,
              userId,
              username,
              content,
              media,
              onProactiveMessage: async (message) => {
                await deliverProactiveMessage(
                  channelId,
                  message.text,
                  'delegate',
                  message.artifacts,
                );
              },
              abortSignal: context.abortSignal,
              source: 'imessage',
            }),
          );
          if (result.status === 'error') {
            const failureText = formatChannelGatewayFailure(result.error);
            if (
              failureText === DEFAULT_CHANNEL_INTERRUPTED_REPLY &&
              isLocalIMessageSelfChatContext(context)
            ) {
              return;
            }
            await reply(failureText);
            return;
          }

          const cleanedResultText = stripSilentToken(
            String(result.result || ''),
          );
          const artifacts = result.artifacts || [];
          if (isSilentReply(result.result)) {
            return;
          }
          if (!cleanedResultText.trim() && artifacts.length === 0) {
            return;
          }

          if (artifacts.length > 0) {
            await sendIMessageMediaToChat({
              target: channelId,
              filePath: artifacts[0].path,
              mimeType: artifacts[0].mimeType,
              filename: artifacts[0].filename,
              caption: cleanedResultText || undefined,
            });
            for (let index = 1; index < artifacts.length; index += 1) {
              await sendIMessageMediaToChat({
                target: channelId,
                filePath: artifacts[index].path,
                mimeType: artifacts[index].mimeType,
                filename: artifacts[index].filename,
              });
            }
            return;
          }

          await reply(cleanedResultText);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          logger.error(
            { error, sessionId, channelId },
            'iMessage message handling failed',
          );
          await reply(formatError('Gateway Error', text));
        }
      },
    );
  } catch (error) {
    logger.warn({ error }, 'iMessage integration failed to start');
    return false;
  }
  logger.info(
    {
      backend: imessageConfig.backend,
      webhookPath: imessageConfig.webhookPath,
    },
    'iMessage integration started inside gateway',
  );
  return true;
}

function setupShutdown(broadcastShutdown: () => void): void {
  let shuttingDown = false;
  const shutdown = async (opts?: { drain?: boolean }) => {
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
    await shutdownEmail().catch((error) => {
      logger.debug({ error }, 'Failed to stop email runtime during shutdown');
    });
    await shutdownSlack().catch((error) => {
      logger.debug({ error }, 'Failed to stop Slack runtime during shutdown');
    });
    await shutdownTelegram().catch((error) => {
      logger.debug(
        { error },
        'Failed to stop Telegram runtime during shutdown',
      );
    });
    await shutdownWhatsApp().catch((error) => {
      logger.debug(
        { error },
        'Failed to stop WhatsApp runtime during shutdown',
      );
    });
    await shutdownVoice({ drain: opts?.drain }).catch((error) => {
      logger.debug({ error }, 'Failed to stop Voice runtime during shutdown');
    });
    await shutdownIMessage().catch((error) => {
      logger.debug(
        { error },
        'Failed to stop iMessage runtime during shutdown',
      );
    });
    if (opts?.drain) {
      broadcastShutdown();
      const DRAIN_TIMEOUT_MS = 15_000;
      const DRAIN_POLL_MS = 250;
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      while (getActiveExecutorCount() > 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, DRAIN_POLL_MS),
        );
      }
    }
    await runManagedMediaCleanup('shutdown');
    stopHeartbeat();
    stopObservabilityIngest();
    stopDiscoveryLoop();
    stopAllExecutions();
    await stopGatewayPlugins().catch((error) => {
      logger.debug({ error }, 'Failed to stop plugins during shutdown');
    });
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
    void shutdown({ drain: true });
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
        ? resolveLastUsedDeliverableChannelId()
        : null;

  if (request.delivery.kind === 'last-channel' && !resolvedDeliveryChannelId) {
    logger.info(
      {
        jobId: request.jobId,
        taskId: request.taskId,
        source: request.source,
        actionKind: request.actionKind,
        delivery: request.delivery.kind,
      },
      'Scheduled task skipped: no delivery channel available',
    );
    return;
  }

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
        'No delivery channel available for scheduled system event delivery.',
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
        throw new Error(
          'No delivery channel available for scheduled delivery.',
        );
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
    request.agentId,
  );
}

function startOrRestartHeartbeat(): void {
  stopHeartbeat();
  const { agentId } = resolveAgentForRequest({});
  startHeartbeat(agentId, HEARTBEAT_INTERVAL, (text) => {
    const channelId = resolveHeartbeatDeliveryChannelId({
      explicitChannelId: HEARTBEAT_CHANNEL,
      lastUsedChannelId: resolveLastUsedDeliverableChannelId(),
    });
    if (!channelId) {
      logger.info(
        { text },
        'Heartbeat message dropped: no delivery channel available',
      );
      return;
    }
    void deliverProactiveMessage(channelId, text, 'heartbeat');
    logger.info({ channelId, text }, 'Heartbeat message');
  });
}

function stopMemoryConsolidationScheduler(): void {
  if (!memoryConsolidationTimer) return;
  clearTimeout(memoryConsolidationTimer);
  memoryConsolidationTimer = null;
}

function startOrRestartMemoryConsolidationScheduler(): void {
  stopMemoryConsolidationScheduler();
  if (!isMemoryConsolidationEnabled()) {
    logger.info('Memory consolidation scheduler disabled');
    return;
  }

  if (!hasDreamRunToday()) {
    void runMemoryConsolidation({
      trigger: 'startup',
      requireSchedulerEnabled: true,
    }).catch(() => undefined);
  }
  scheduleNextMemoryConsolidationRun();
}

async function main(): Promise<void> {
  logger.info('Starting HybridClaw gateway');
  initDatabase();
  listAgents();
  await initGatewayService();
  resumeEnabledFullAutoSessions();
  void runManagedMediaCleanup('startup').catch((error) => {
    logger.warn({ error }, 'Managed media cleanup failed during startup');
  });
  const httpServer = startGatewayHttpServer();
  setupShutdown(httpServer.broadcastShutdown.bind(httpServer));
  const discordActive = await startDiscordIntegration();
  const msteamsActive = await startMSTeamsIntegration();
  const slackActive = await startSlackIntegration();
  const emailActive = await startEmailIntegration();
  const telegramActive = await startTelegramIntegration();
  const whatsappActive = await startWhatsAppIntegration();
  const voiceActive = await startVoiceIntegration();
  const imessageActive = await startIMessageIntegration();

  startOrRestartHeartbeat();
  startObservabilityIngest();
  startDiscoveryLoop();
  void localBackendsProbe.get().catch((err) => {
    logger.warn({ err }, 'Startup warm-up of local backends probe failed');
  });
  void hybridAIProbe.get().catch((err) => {
    logger.warn({ err }, 'Startup warm-up of HybridAI probe failed');
  });
  detachConfigListener = onConfigChange((next, prev) => {
    void refreshEmailIntegrationForConfigChange(next, prev).catch((error) => {
      logger.warn(
        { error },
        'Email integration restart failed after config change',
      );
    });
    void refreshTelegramIntegrationForConfigChange(next, prev).catch(
      (error) => {
        logger.warn(
          { error },
          'Telegram integration restart failed after config change',
        );
      },
    );
    void refreshSlackIntegrationForConfigChange(next, prev).catch((error) => {
      logger.warn(
        { error },
        'Slack integration restart failed after config change',
      );
    });
    void refreshVoiceIntegrationForConfigChange(next, prev).catch((error) => {
      logger.warn(
        { error },
        'Voice integration restart failed after config change',
      );
    });

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
    const localConfigChanged =
      JSON.stringify(next.local) !== JSON.stringify(prev.local);
    if (localConfigChanged) {
      logger.info(
        'Config changed, restarting local discovery and invalidating health cache',
      );
      startDiscoveryLoop();
      localBackendsProbe.invalidate();
    }
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

  logGatewayStartup({
    status: await getGatewayStatus(),
    channels: {
      discord: discordActive,
      msteams: msteamsActive,
      slack: slackActive,
      email: emailActive,
      imessage: imessageActive,
      telegram: telegramActive,
      voice: voiceActive,
      whatsapp: whatsappActive,
    },
  });
  httpServer.setReady();
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
