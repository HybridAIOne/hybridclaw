/**
 * Proactive dispatch validates destinations before sending or persisting a queue row.
 * Only the TUI uses local pull delivery; unknown targets fail explicitly.
 * Channel senders own transport details, not quiet-hour or A2A policy.
 */
import { isA2ALocalModeEnabled } from '../a2a/local-mode.js';
import {
  isWithinActiveHours,
  proactiveWindowLabel,
} from '../agent/proactive-policy.js';
import {
  type ProactiveDeliveryOutcome,
  proactiveDeliveryFailed,
} from '../channels/channel-descriptor.js';
import { getChannelDescriptorForTarget } from '../channels/channel-descriptors.js';
import {
  getConfigSnapshot,
  PROACTIVE_QUEUE_OUTSIDE_HOURS,
} from '../config/config.js';
import { logger } from '../logger.js';
import { enqueueProactiveMessage } from '../memory/db.js';
import type { ArtifactMetadata } from '../types/execution.js';
import {
  isLocalProactivePullChannelId,
  isSupportedProactiveChannelId,
  shouldSuppressProactiveMessage,
} from './proactive-delivery.js';
export const MAX_QUEUED_PROACTIVE_MESSAGES = 100;

export async function deliverProactiveMessage(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  channelId = channelId.trim();
  if (!isSupportedProactiveChannelId(channelId)) {
    return {
      status: 'failed',
      reason: `No proactive delivery path for channel "${channelId}"`,
    };
  }
  if (isA2ALocalModeEnabled(getConfigSnapshot()) && channelId !== 'tui') {
    logger.info(
      { source, channelId },
      'Proactive channel delivery suppressed by A2A local mode',
    );
    return { status: 'suppressed', reason: 'A2A local mode' };
  }
  if (shouldSuppressProactiveMessage({ source, text })) {
    logger.debug({ source, channelId }, 'Proactive message suppressed');
    return { status: 'suppressed', reason: 'Heartbeat OK' };
  }

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
      return { status: 'queued', reason: 'Outside active hours' };
    }
    logger.info(
      { source, channelId, activeHours: proactiveWindowLabel() },
      'Proactive message suppressed (outside active hours)',
    );
    return { status: 'suppressed', reason: 'Outside active hours' };
  }

  return sendProactiveMessageNow(channelId, text, source, artifacts);
}

export async function sendProactiveMessageNow(
  channelId: string,
  text: string,
  source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  channelId = channelId.trim();
  if (!isSupportedProactiveChannelId(channelId)) {
    return {
      status: 'failed',
      reason: `No proactive delivery path for channel "${channelId}"`,
    };
  }
  if (isA2ALocalModeEnabled(getConfigSnapshot()) && channelId !== 'tui') {
    return { status: 'suppressed', reason: 'A2A local mode' };
  }
  const descriptor = getChannelDescriptorForTarget(channelId);
  if (descriptor?.supportsProactive && descriptor.sendProactive) {
    try {
      const outcome = await descriptor.sendProactive(
        channelId,
        text,
        source,
        artifacts,
      );
      if (outcome.status === 'failed')
        logger.info(
          { source, channelId, reason: outcome.reason },
          'Proactive channel delivery failed',
        );
      return outcome;
    } catch (error) {
      logger.warn(
        { source, channelId, error, artifactCount: artifacts?.length ?? 0 },
        'Failed to send proactive message',
      );
      return proactiveDeliveryFailed(error);
    }
  }
  if (!isLocalProactivePullChannelId(channelId)) {
    return {
      status: 'failed',
      reason: `No proactive delivery path for channel "${channelId}"`,
    };
  }
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
      artifactCount: artifacts?.length ?? 0,
    },
    'Proactive message queued for local channel delivery',
  );
  if (artifacts?.length)
    logger.warn(
      { source, channelId, artifactCount: artifacts.length },
      'Queued proactive local delivery does not persist attachments; only text was queued',
    );
  return { status: 'queued' };
}
