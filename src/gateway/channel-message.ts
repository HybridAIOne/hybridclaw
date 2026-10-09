/**
 * Shared channel replies preserve approval ownership and gateway execution semantics.
 * Channel integrations provide presentation and transport; this module never
 * starts a runtime or owns its lifecycle.
 */
import fs from 'node:fs';
import type { AttachmentBuilder } from 'discord.js';
import type { ReplyFn } from '../channels/discord/runtime.js';
import { logger } from '../logger.js';
import {
  type ArtifactMetadata,
  type EscalationTarget,
  normalizeEscalationTarget,
} from '../types/execution.js';
import { buildApprovalConfirmationComponents } from './approval-confirmation.js';
import {
  type ApprovalPresentation,
  createApprovalPresentation,
  getApprovalPromptText,
} from './approval-presentation.js';
import { normalizePlaceholderToolReply } from './chat-result.js';
import { handleGatewayMessage } from './gateway-chat-service.js';
import { handleGatewayCommand } from './gateway-service.js';
import type {
  GatewayChatApprovalEvent,
  GatewayChatRequest,
  GatewayChatResult,
  GatewayCommandResult,
} from './gateway-types.js';
import {
  getPendingApproval,
  rememberPendingApproval,
} from './pending-approvals.js';
import { isDiscordChannelId } from './proactive-delivery.js';
import {
  handleTextChannelApprovalCommand,
  renderTextChannelCommandResult,
  resolvePendingApprovalSessionId,
  resolveTextChannelSlashCommands,
} from './text-channel-commands.js';

type ApprovalNotificationSender = (params: {
  approval: Pick<GatewayChatApprovalEvent, 'approvalId' | 'prompt' | 'summary'>;
  presentation: ApprovalPresentation;
  userId: string;
}) => Promise<{ disableButtons: () => Promise<void> } | null>;

export function formatRoutedApprovalNotice(
  approval: { approvalId: string },
  target: EscalationTarget,
): string {
  return `Escalation routed to ${target.recipient} on ${target.channel}. Approval ID: ${approval.approvalId}`;
}

export async function handlePendingApprovalRouting(params: {
  pendingApproval: GatewayChatApprovalEvent;
  responseText: string;
  sessionId: string;
  userId: string;
  channelId: string;
  buttonPresentation: ApprovalPresentation;
  sendApprovalNotification?: ApprovalNotificationSender;
  sendText: (text: string) => Promise<void>;
  formatTextPrompt?: (input: {
    approval: GatewayChatApprovalEvent;
    approvalUserId: string;
    responseText: string;
    storedPrompt: string;
  }) => string;
}): Promise<{ cleanup: { disableButtons: () => Promise<void> } | null }> {
  const escalationTarget = normalizeEscalationTarget(
    params.pendingApproval.escalationTarget,
  );
  const approvalUserId = escalationTarget?.recipient || params.userId;
  const routedTarget =
    escalationTarget && escalationTarget.channel !== params.channelId
      ? escalationTarget
      : null;
  const storedPrompt = getApprovalPromptText(
    params.pendingApproval,
    params.responseText,
  );
  const presentation =
    params.sendApprovalNotification && !routedTarget
      ? params.buttonPresentation
      : createApprovalPresentation('text');
  let cleanup: { disableButtons: () => Promise<void> } | null = null;

  if (params.sendApprovalNotification && !routedTarget) {
    cleanup = await params.sendApprovalNotification({
      approval: params.pendingApproval,
      presentation,
      userId: approvalUserId,
    });
  } else if (routedTarget) {
    await params.sendText(
      formatRoutedApprovalNotice(params.pendingApproval, routedTarget),
    );
  } else {
    await params.sendText(
      params.formatTextPrompt?.({
        approval: params.pendingApproval,
        approvalUserId,
        responseText: params.responseText,
        storedPrompt,
      }) ?? storedPrompt,
    );
  }

  await rememberPendingApproval({
    sessionId: params.sessionId,
    approvalId: params.pendingApproval.approvalId,
    prompt: storedPrompt,
    userId: approvalUserId,
    expiresAt: params.pendingApproval.expiresAt,
    presentation,
    disableButtons: cleanup?.disableButtons ?? null,
  });

  return { cleanup };
}

export async function buildArtifactAttachments(
  artifacts?: ArtifactMetadata[],
): Promise<AttachmentBuilder[]> {
  if (!artifacts || artifacts.length === 0) return [];
  const { AttachmentBuilder } = await import('discord.js');
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

export function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

export function simplifyImageAttachmentNarration(
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

export function resolveImplicitNumericApprovalArgs(params: {
  sessionId: string;
  userId: string;
  content: string;
}): string[] | null {
  const pending = getPendingApproval(
    resolvePendingApprovalSessionId(params.sessionId),
  );
  if (!pending || pending.userId !== params.userId) return null;

  const normalized = params.content.trim();
  if (normalized === '1') return ['approve', '1'];
  if (normalized === '2') return ['approve', '2'];
  if (normalized === '3') return ['approve', '3'];
  if (normalized === '4') return ['approve', '4'];
  if (normalized === '5') return ['approve', '5'];
  return null;
}

export async function handleTextChannelCommand(params: {
  msteamsTenantId?: string;
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  args: string[];
  reply: ReplyFn;
  /**
   * Channel-specific presentation hook. Return true after delivering the
   * result to skip the default text reply.
   */
  onCommandResult?: (
    result: GatewayCommandResult,
    renderedText: string,
  ) => Promise<boolean>;
}): Promise<void> {
  const { sessionId, guildId, channelId, userId, username, args, reply } =
    params;
  const handledApproval = await handleTextChannelApprovalCommand({
    msteamsTenantId: params.msteamsTenantId,
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
      isDiscordChannelId(channelId)
        ? await buildArtifactAttachments(handledApproval.artifacts)
        : undefined,
    );
    return;
  }
  const result = await handleGatewayCommand({
    msteamsTenantId: params.msteamsTenantId,
    sessionId,
    guildId,
    channelId,
    args,
    userId,
    username,
    onProactiveMessage: async (message) => {
      await reply(
        message.text,
        isDiscordChannelId(channelId)
          ? await buildArtifactAttachments(message.artifacts)
          : undefined,
      );
    },
  });
  const text = renderTextChannelCommandResult(result);
  if (params.onCommandResult && (await params.onCommandResult(result, text))) {
    return;
  }
  if (result.components !== undefined) {
    await reply(text, undefined, result.components);
    return;
  }
  await reply(text);
}

export async function runTextChannelSlashCommands(params: {
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

export async function executeTextChannelGatewayTurn(params: {
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
  const handledSlashCommands = await runTextChannelSlashCommands({
    sessionId: params.sessionId,
    guildId: params.guildId,
    channelId: params.channelId,
    userId: params.userId,
    username: params.username,
    content: params.content,
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
      content: params.content,
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
