import fs from 'node:fs';
import { AttachmentBuilder } from 'discord.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import { sendToChannel } from '../channels/discord/runtime.js';
import { isEmailAddress as isNormalizedEmailAddress } from '../channels/email/allowlist.js';
import {
  sendEmailAttachmentTo,
  sendToEmail,
} from '../channels/email/runtime.js';
import { getWhatsAppAuthStatus } from '../channels/whatsapp/auth.js';
import { isWhatsAppJid } from '../channels/whatsapp/phone.js';
import { sendToWhatsAppChat } from '../channels/whatsapp/runtime.js';
import {
  DISCORD_TOKEN,
  EMAIL_PASSWORD,
  getConfigSnapshot,
  PROACTIVE_QUEUE_OUTSIDE_HOURS,
} from '../config/config.js';
import { logger } from '../logger.js';
import {
  enqueueProactiveMessage,
  getMostRecentSessionChannelId,
  type QueuedProactiveMessage,
} from '../memory/db.js';
import type { ArtifactMetadata } from '../types.js';

const DISCORD_CHANNEL_ID_RE = /^\d{16,22}$/;
const LOCAL_PROACTIVE_PULL_CHANNEL_IDS = new Set(['tui']);
export const MAX_QUEUED_PROACTIVE_MESSAGES = 100;

export interface ProactiveDeliveryOptions {
  strict?: boolean;
  timeoutMs?: number;
}

export function isDiscordChannelId(channelId: string): boolean {
  return DISCORD_CHANNEL_ID_RE.test(channelId);
}

export function isEmailAddress(channelId: string): boolean {
  return isNormalizedEmailAddress(channelId.trim());
}

export function isSupportedProactiveChannelId(channelId: string): boolean {
  const trimmed = channelId.trim();
  if (!trimmed) return false;
  if (isDiscordChannelId(trimmed)) return true;
  if (isWhatsAppJid(trimmed)) return true;
  if (isEmailAddress(trimmed)) return true;
  return LOCAL_PROACTIVE_PULL_CHANNEL_IDS.has(trimmed);
}

export function hasQueuedProactiveDeliveryPath(
  item: Pick<QueuedProactiveMessage, 'channel_id'>,
): boolean {
  return isSupportedProactiveChannelId(item.channel_id);
}

export function resolveHeartbeatDeliveryChannelId(params: {
  explicitChannelId: string;
  lastUsedChannelId: string | null;
}): string | null {
  const explicitChannelId = params.explicitChannelId.trim();
  if (explicitChannelId) return explicitChannelId;
  return params.lastUsedChannelId;
}

export function shouldDropQueuedProactiveMessage(
  item: Pick<QueuedProactiveMessage, 'channel_id' | 'source'>,
): boolean {
  if (!hasQueuedProactiveDeliveryPath(item)) return true;
  return item.source === 'heartbeat' && item.channel_id === 'heartbeat';
}

function buildDiscordAttachments(
  artifacts?: ArtifactMetadata[],
): AttachmentBuilder[] {
  if (!artifacts || artifacts.length === 0) return [];
  const attachments: AttachmentBuilder[] = [];
  for (const artifact of artifacts) {
    try {
      attachments.push(
        new AttachmentBuilder(fs.readFileSync(artifact.path), {
          name: artifact.filename,
        }),
      );
    } catch (error) {
      logger.warn(
        { artifactPath: artifact.path, error },
        'Failed to read artifact for proactive Discord attachment',
      );
    }
  }
  return attachments;
}

async function sendProactiveMessageNow(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
  options?: ProactiveDeliveryOptions,
): Promise<void> {
  const strict = options?.strict === true;
  const attachments = buildDiscordAttachments(artifacts);

  if (isWhatsAppJid(channelId)) {
    const whatsappAuth = await getWhatsAppAuthStatus();
    if (!whatsappAuth.linked) {
      if (strict) {
        throw new Error(
          'Proactive WhatsApp delivery failed: WhatsApp is not linked.',
        );
      }
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
      if (strict) {
        throw error;
      }
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
      if (strict) {
        throw new Error(
          'Proactive email delivery failed: email channel is not configured.',
        );
      }
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
      if (strict) {
        throw error;
      }
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
    if (strict) {
      throw new Error(
        'Proactive Discord delivery failed: Discord is not configured.',
      );
    }
    logger.info(
      { source, channelId, text, artifactCount: attachments.length },
      'Proactive message (no Discord delivery)',
    );
    return;
  }

  try {
    await sendToChannel(channelId, text, attachments);
  } catch (error) {
    if (strict) {
      throw error;
    }
    logger.warn(
      { source, channelId, error, artifactCount: attachments.length },
      'Failed to send proactive message to Discord channel',
    );
    logger.info({ source, channelId, text }, 'Proactive message fallback');
  }
}

export async function deliverProactiveMessage(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
  options?: ProactiveDeliveryOptions,
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
    if (options?.strict) {
      throw new Error(
        `Proactive delivery failed: outside active hours (${proactiveWindowLabel()}).`,
      );
    }
    logger.info(
      { source, channelId, activeHours: proactiveWindowLabel() },
      'Proactive message suppressed (outside active hours)',
    );
    return;
  }

  await sendProactiveMessageNow(channelId, text, source, artifacts, options);
}

export async function deliverWebhookMessage(
  webhookUrl: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
  options?: {
    timeoutMs?: number;
  },
): Promise<void> {
  try {
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
      signal:
        options?.timeoutMs && options.timeoutMs > 0
          ? AbortSignal.timeout(options.timeoutMs)
          : undefined,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Webhook delivery failed (${response.status}): ${body.slice(0, 300)}`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        error.name === 'TimeoutError' ||
        /aborted|timed out/i.test(error.message))
    ) {
      throw new Error(
        `Webhook delivery timed out after ${Math.max(1, Math.trunc(options?.timeoutMs || 0))}ms.`,
      );
    }
    throw error;
  }
}

export function resolveLastUsedDeliverableChannelId(): string | null {
  const channelId = getMostRecentSessionChannelId();
  if (!channelId) return null;
  return hasQueuedProactiveDeliveryPath({ channel_id: channelId })
    ? channelId
    : null;
}
