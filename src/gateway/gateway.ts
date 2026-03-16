import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import { stopAllExecutions } from '../agent/executor.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { isSilentReply, stripSilentToken } from '../agent/silent-reply.js';
import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import {
  startObservabilityIngest,
  stopObservabilityIngest,
} from '../audit/observability-ingest.js';
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
  initEmail,
  sendEmailAttachmentTo,
  sendToEmail,
  shutdownEmail,
} from '../channels/email/runtime.js';
import { buildTeamsArtifactAttachments } from '../channels/msteams/attachments.js';
import { initMSTeams } from '../channels/msteams/runtime.js';
import { getWhatsAppAuthStatus } from '../channels/whatsapp/auth.js';
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
import {
  startDiscoveryLoop,
  stopDiscoveryLoop,
} from '../providers/local-discovery.js';
import {
  startHealthCheckLoop,
  stopHealthCheckLoop,
} from '../providers/local-health.js';
import { startHeartbeat, stopHeartbeat } from '../scheduler/heartbeat.js';
import {
  rearmScheduler,
  type SchedulerDispatchRequest,
  startScheduler,
  stopScheduler,
} from '../scheduler/scheduler.js';
import {
  mapTuiSlashCommandToGatewayArgs,
  parseTuiSlashCommand,
} from '../tui-slash-command.js';
import type { ArtifactMetadata } from '../types.js';
import { buildApprovalConfirmationComponents } from './approval-confirmation.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
} from './chat-result.js';
import { classifyGatewayError } from './gateway-error-utils.js';
import {
  getGatewayStatus,
  handleGatewayCommand,
  handleGatewayMessage,
  initGatewayService,
  renderGatewayCommand,
  resumeEnabledFullAutoSessions,
  runGatewayScheduledTask,
} from './gateway-service.js';
import { startHealthServer } from './health.js';
import { runManagedMediaCleanup } from './managed-media-cleanup.js';
import {
  cleanupExpiredPendingApprovals,
  clearPendingApproval,
  getPendingApproval,
  type PendingApprovalPrompt,
  setPendingApproval,
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

let detachConfigListener: (() => void) | null = null;
let proactiveFlushTimer: ReturnType<typeof setInterval> | null = null;
let memoryConsolidationTimer: ReturnType<typeof setInterval> | null = null;

const MAX_QUEUED_PROACTIVE_MESSAGES = 100;
const APPROVAL_PROMPT_DEFAULT_TTL_MS = 120_000;
const WHATSAPP_INTERRUPTED_REPLY =
  'The request was interrupted before I could reply. Please send it again.';
const WHATSAPP_TRANSIENT_FAILURE_REPLY =
  'The model request failed before I could reply. Please try again.';
const EMAIL_INTERRUPTED_REPLY =
  'The request was interrupted before I could reply. Please send it again.';
const EMAIL_TRANSIENT_FAILURE_REPLY =
  'The model request failed before I could reply. Please try again.';

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

function formatWhatsAppGatewayFailure(
  error: string | null | undefined,
): string {
  const detail = String(error || '').trim();
  if (
    /interrupted by user|timed out|timeout waiting for agent output|terminated|abort/i.test(
      detail,
    )
  ) {
    return WHATSAPP_INTERRUPTED_REPLY;
  }
  if (detail && classifyGatewayError(detail) === 'transient') {
    return WHATSAPP_TRANSIENT_FAILURE_REPLY;
  }
  return formatError('Agent Error', detail || 'Unknown error');
}

function formatEmailGatewayFailure(error: string | null | undefined): string {
  const detail = String(error || '').trim();
  if (
    /interrupted by user|timed out|timeout waiting for agent output|terminated|abort/i.test(
      detail,
    )
  ) {
    return EMAIL_INTERRUPTED_REPLY;
  }
  if (detail && classifyGatewayError(detail) === 'transient') {
    return EMAIL_TRANSIENT_FAILURE_REPLY;
  }
  return formatError('Agent Error', detail || 'Unknown error');
}

async function rememberPendingApproval(params: {
  sessionId: string;
  approvalId: string;
  prompt: string;
  userId: string;
  expiresAt?: number | null;
  disableButtons?: (() => Promise<void>) | null;
}): Promise<void> {
  const createdAt = Date.now();
  const expiresAt =
    typeof params.expiresAt === 'number' && Number.isFinite(params.expiresAt)
      ? Math.max(createdAt + 15_000, params.expiresAt)
      : createdAt + APPROVAL_PROMPT_DEFAULT_TTL_MS;
  const entry: PendingApprovalPrompt = {
    approvalId: params.approvalId,
    prompt: params.prompt,
    createdAt,
    expiresAt,
    userId: params.userId,
    resolvedAt: null,
    disableButtons: params.disableButtons ?? null,
    disableTimeout: null,
  };
  entry.disableTimeout = setTimeout(
    () => {
      void clearPendingApproval(params.sessionId, { disableButtons: true });
    },
    Math.max(0, expiresAt - Date.now()),
  );
  await setPendingApproval(params.sessionId, entry);
}

function buildApprovalUserMessage(params: {
  action: string;
  approvalId: string;
}): string | null {
  const action = params.action.trim().toLowerCase();
  const approvalId = params.approvalId.trim();
  const withApprovalId = (base: string): string =>
    approvalId ? `${base} ${approvalId}` : base;

  if (action === 'yes' || action === '1') {
    return withApprovalId('yes');
  }
  if (action === 'session' || action === '2') {
    return approvalId ? `yes ${approvalId} for session` : 'yes for session';
  }
  if (action === 'agent' || action === '3') {
    return approvalId ? `yes ${approvalId} for agent` : 'yes for agent';
  }
  if (
    action === 'no' ||
    action === 'deny' ||
    action === 'skip' ||
    action === '4'
  ) {
    return withApprovalId('no');
  }
  return null;
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
  return null;
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

  await cleanupExpiredPendingApprovals();
  const pending = getPendingApproval(sessionId);
  const action = (args[1] || 'view').trim().toLowerCase();
  const providedApprovalId = (args[2] || '').trim();
  const currentApprovalId = pending?.approvalId || '';
  const approvalId = providedApprovalId || currentApprovalId;
  const pendingComponents =
    pending && isDiscordChannelId(channelId)
      ? buildApprovalConfirmationComponents(pending.approvalId)
      : undefined;

  if (action === 'view' || action === 'status' || action === 'show') {
    if (!pending || pending.userId !== userId) {
      await reply('No pending approval request for you in this session.');
      return true;
    }
    await reply(
      formatInfo('Pending Approval', pending.prompt),
      undefined,
      pendingComponents,
    );
    return true;
  }

  const approvalContent = buildApprovalUserMessage({ action, approvalId });

  if (!approvalContent) {
    await reply(
      'Usage: `/approve action:view|yes|session|agent|no [approval_id]`',
    );
    return true;
  }

  if (!approvalId && !pending) {
    await reply('No pending approval request for this session.');
    return true;
  }

  const approvalResult = normalizePendingApprovalReply(
    normalizePlaceholderToolReply(
      await handleGatewayMessage({
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content: approvalContent,
        media: [],
      }),
    ),
  );
  if (approvalResult.status === 'error') {
    await reply(
      formatError('Approval Error', approvalResult.error || 'Unknown error'),
    );
    return true;
  }
  if (isSilentReply(approvalResult.result)) {
    await clearPendingApproval(sessionId, { disableButtons: true });
    return true;
  }
  const approvalResultText = stripSilentToken(String(approvalResult.result));
  if (!approvalResultText.trim()) {
    await clearPendingApproval(sessionId, { disableButtons: true });
    return true;
  }

  const resultText = buildResponseText(
    approvalResultText,
    approvalResult.toolsUsed,
  );
  const pendingApproval = extractGatewayChatApprovalEvent(approvalResult);
  if (pendingApproval) {
    const components = isDiscordChannelId(channelId)
      ? buildApprovalConfirmationComponents(pendingApproval.approvalId)
      : undefined;
    await rememberPendingApproval({
      sessionId,
      approvalId: pendingApproval.approvalId,
      prompt: pendingApproval.prompt || resultText,
      userId,
      expiresAt: pendingApproval.expiresAt,
    });
    await reply(
      formatInfo('Pending Approval', resultText),
      undefined,
      components,
    );
    return true;
  }

  await clearPendingApproval(sessionId, { disableButtons: true });
  const attachments = buildArtifactAttachments(approvalResult.artifacts);
  await reply(resultText, attachments);
  return true;
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
    userId,
    username,
  });
  if (result.kind === 'error') {
    await reply(formatError(result.title || 'Error', result.text));
    return;
  }
  if (result.kind === 'info') {
    const text = formatInfo(result.title || 'Info', result.text);
    if (result.components !== undefined) {
      await reply(text, undefined, result.components);
    } else {
      await reply(text);
    }
    return;
  }
  await reply(renderGatewayCommand(result));
}

function resolveTextChannelSlashCommands(content: string): string[][] | null {
  if (!content.trim().startsWith('/')) return null;

  const parsed = parseTuiSlashCommand(content);
  if (!parsed.cmd || parsed.parts.length === 0) return null;

  if (parsed.cmd === 'approve') {
    return [parsed.parts];
  }

  if (parsed.cmd === 'info') {
    return [['bot', 'info'], ['model', 'info'], ['status']];
  }

  const args = mapTuiSlashCommandToGatewayArgs(parsed.parts);
  return args ? [args] : null;
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
        if (!pendingApproval) {
          const bufferedDelta = streamFilter.flush();
          if (bufferedDelta) {
            await appendStreamText(bufferedDelta);
          }
        }
        if (streamFilter.isSilent() || isSilentReply(result.result)) {
          await clearPendingApproval(sessionId, { disableButtons: true });
          await context.stream.discard();
          return;
        }
        const rawText = stripSilentToken(String(result.result));
        const showMode = normalizeSessionShowMode(
          memoryService.getSessionById(sessionId)?.show_mode,
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
        );
        if (pendingApproval) {
          let cleanup: { disableButtons: () => Promise<void> } | null = null;
          if (context.sendApprovalNotification) {
            cleanup = await context.sendApprovalNotification({
              text: 'Approval required — use buttons below or `/approve` to respond.',
              approvalId: pendingApproval.approvalId,
              userId,
            });
          } else {
            await context.stream.finalize(
              `<@${userId}> approval required. Use \`/approve\` to view and respond privately.`,
            );
          }
          await rememberPendingApproval({
            sessionId,
            approvalId: pendingApproval.approvalId,
            prompt: pendingApproval.prompt || responseText,
            userId,
            expiresAt: pendingApproval.expiresAt,
            disableButtons: cleanup?.disableButtons ?? null,
          });
          if (cleanup) {
            await context.stream.discard();
          }
          return;
        }
        const attachments = buildArtifactAttachments(result.artifacts);
        if (!rawText.trim()) {
          await clearPendingApproval(sessionId, { disableButtons: true });
          await context.stream.discard();
          return;
        }
        await clearPendingApproval(sessionId, { disableButtons: true });
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
  logger.info('Discord integration started inside gateway');
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
        if (!renderedText.trim() && artifacts.length === 0) {
          await context.stream.discard();
          return;
        }
        const showMode = normalizeSessionShowMode(
          memoryService.getSessionById(sessionId)?.show_mode,
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
          await rememberPendingApproval({
            sessionId,
            approvalId: pendingApproval.approvalId,
            prompt: pendingApproval.prompt || responseText,
            userId,
            expiresAt: pendingApproval.expiresAt,
          });
          await context.stream.finalize(
            `${responseText}\n\nApproval required. Reply \`1\` to allow once, \`2\` to allow for this session, \`3\` to allow for this agent, or \`4\` to deny. You can also use \`/approve view\` or \`/approve [1|2|3|4]\`.`,
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
  const whatsappAuth = await getWhatsAppAuthStatus();
  if (!whatsappAuth.linked) {
    logger.info('WhatsApp integration disabled: no linked auth state found');
    return false;
  }

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
          await reply(formatWhatsAppGatewayFailure(result.error));
          return;
        }

        const cleanedResultText = stripSilentToken(String(result.result || ''));
        const artifacts = result.artifacts || [];
        if (isSilentReply(result.result)) {
          return;
        }
        if (!cleanedResultText.trim() && artifacts.length === 0) {
          return;
        }

        const showMode = normalizeSessionShowMode(
          memoryService.getSessionById(sessionId)?.show_mode,
        );
        if (cleanedResultText.trim()) {
          const responseText = buildResponseText(
            cleanedResultText,
            sessionShowModeShowsTools(showMode) ? result.toolsUsed : undefined,
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
        await reply(formatWhatsAppGatewayFailure(text));
      }
    },
  );
  logger.info('WhatsApp integration started inside gateway');
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
            await reply(formatEmailGatewayFailure(result.error));
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

          const showMode = normalizeSessionShowMode(
            memoryService.getSessionById(sessionId)?.show_mode,
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
              await sendEmailAttachmentTo({
                to: channelId,
                filePath: artifact.path,
                mimeType: artifact.mimeType,
                filename: artifact.filename,
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
          await reply(formatEmailGatewayFailure(text));
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
    await shutdownEmail().catch((error) => {
      logger.debug({ error }, 'Failed to stop email runtime during shutdown');
    });
    await shutdownWhatsApp().catch((error) => {
      logger.debug(
        { error },
        'Failed to stop WhatsApp runtime during shutdown',
      );
    });
    await runManagedMediaCleanup('shutdown');
    stopHeartbeat();
    stopObservabilityIngest();
    stopDiscoveryLoop();
    stopHealthCheckLoop();
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
        ? resolveLastUsedDeliverableChannelId()
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
  initGatewayService();
  resumeEnabledFullAutoSessions();
  void runManagedMediaCleanup('startup').catch((error) => {
    logger.warn({ error }, 'Managed media cleanup failed during startup');
  });
  startHealthServer();
  setupShutdown();
  await startDiscordIntegration();
  const msteamsActive = await startMSTeamsIntegration();
  const emailActive = await startEmailIntegration();
  const whatsappActive = await startWhatsAppIntegration();

  startOrRestartHeartbeat();
  startObservabilityIngest();
  startDiscoveryLoop();
  startHealthCheckLoop();
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
    const localConfigChanged =
      JSON.stringify(next.local) !== JSON.stringify(prev.local);
    if (localConfigChanged) {
      logger.info(
        'Config changed, restarting local discovery and health loops',
      );
      startDiscoveryLoop();
      startHealthCheckLoop();
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

  logger.info(
    {
      ...getGatewayStatus(),
      discord: !!DISCORD_TOKEN,
      msteams: msteamsActive,
      email: emailActive,
      whatsapp: whatsappActive,
    },
    'HybridClaw gateway started',
  );
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start gateway');
  process.exit(1);
});
