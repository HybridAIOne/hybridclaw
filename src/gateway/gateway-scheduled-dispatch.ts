/**
 * Scheduled runs fail when their delivery target fails. Web conversations are
 * durable targets and reuse the runner's stored message; channel transports
 * retain their active-hours policy. This dispatcher does not own scheduling.
 */
import { logger } from '../logger.js';
import type { SchedulerDispatchRequest } from '../scheduler/scheduler.js';
import type { ArtifactMetadata } from '../types/execution.js';
import { runGatewayScheduledTask } from './gateway-scheduled-task-service.js';
import { isHeartbeatOkText } from './proactive-delivery.js';
import {
  deliverWebScheduledMessage,
  mainChatForWebTask,
} from './web-scheduled-delivery.js';

interface ScheduledDeliveryDependencies {
  deliverProactiveMessage: (
    channelId: string,
    text: string,
    source: string,
    artifacts?: ArtifactMetadata[],
  ) => Promise<{
    status: 'delivered' | 'queued' | 'suppressed' | 'failed';
    reason?: string;
  }>;
  deliverWebhookMessage: (
    url: string,
    text: string,
    source: string,
    artifacts?: ArtifactMetadata[],
  ) => Promise<void>;
  resolveLastUsedDeliverableChannelId: () => string | null;
}

export async function runScheduledTask(
  request: SchedulerDispatchRequest,
  {
    deliverProactiveMessage,
    deliverWebhookMessage,
    resolveLastUsedDeliverableChannelId,
  }: ScheduledDeliveryDependencies,
): Promise<void> {
  const sourceLabel =
    request.source === 'scheduled-task'
      ? `schedule:${request.resultSourceTaskId ?? request.taskId ?? 'unknown'}`
      : `schedule-job:${request.jobId ?? 'unknown'}`;
  const resolvedDeliveryChannelId =
    request.delivery.kind === 'channel'
      ? request.delivery.channelId
      : request.delivery.kind === 'last-channel'
        ? resolveLastUsedDeliverableChannelId()
        : null;

  if (request.delivery.kind === 'last-channel' && !resolvedDeliveryChannelId) {
    logger.warn(
      {
        jobId: request.jobId,
        taskId: request.taskId,
        source: request.source,
        actionKind: request.actionKind,
        delivery: request.delivery.kind,
      },
      'Scheduled task skipped: no delivery channel available',
    );
    throw new Error(
      'No delivery channel available: no recently used channel supports proactive delivery.',
    );
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
    const outcome =
      resolvedDeliveryChannelId === 'web'
        ? deliverWebScheduledMessage(
            request.sessionId,
            request.prompt,
            `${sourceLabel}:system`,
          )
        : await deliverProactiveMessage(
            resolvedDeliveryChannelId,
            request.prompt,
            `${sourceLabel}:system`,
          );
    if (outcome.status === 'failed') {
      throw new Error(
        `Delivery to ${resolvedDeliveryChannelId} failed: ${outcome.reason || 'unknown error'}`,
      );
    }
    return;
  }

  // A web task from a side chat replies in its agent's main chat. It then runs
  // apart like `--reply-only`, so the side chat's history is not mixed into the
  // main chat and the run's turn does not land in the side chat.
  const mainChat =
    request.source === 'scheduled-task' && resolvedDeliveryChannelId === 'web'
      ? mainChatForWebTask(request.sessionId)
      : null;
  const deliverySessionId = mainChat?.id ?? request.sessionId;
  const runChannelId =
    request.channelId || resolvedDeliveryChannelId || 'scheduler';
  const taskId = request.taskId ?? -1;
  const runKey =
    request.source === 'scheduler-job'
      ? request.sessionId
      : request.taskId != null
        ? `cron:${request.taskId}`
        : undefined;

  let runError: unknown = null;
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
      if (
        resolvedDeliveryChannelId === 'tui' &&
        (result.artifacts?.length || 0) === 0 &&
        isSchedulerNoopTuiResult(result.text)
      ) {
        logger.info(
          {
            jobId: request.jobId,
            taskId: request.taskId,
            source: request.source,
            channelId: resolvedDeliveryChannelId,
            result: result.text,
          },
          'Scheduled task completed without TUI delivery',
        );
        return;
      }
      const outcome =
        resolvedDeliveryChannelId === 'web'
          ? deliverWebScheduledMessage(
              deliverySessionId,
              result.text,
              sourceLabel,
              result.artifacts,
              result.storedMessage,
              result.workId,
            )
          : await deliverProactiveMessage(
              resolvedDeliveryChannelId,
              result.text,
              sourceLabel,
              result.artifacts,
            );
      if (outcome.status === 'failed') {
        throw new Error(
          `Delivery to ${resolvedDeliveryChannelId} failed: ${outcome.reason || 'unknown error'}`,
        );
      }
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
      runError = error ?? new Error('Scheduled task failed.');
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
    request.replyOnly || mainChat !== null,
    request.taskOwner,
  );
  if (runError !== null) {
    throw runError instanceof Error ? runError : new Error(String(runError));
  }
}

function isSchedulerNoopTuiResult(text: string): boolean {
  if (isHeartbeatOkText(text)) return true;

  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!normalized) return true;

  const reportsNoWork =
    normalized.startsWith('nothing to report') ||
    normalized.startsWith('no work to report') ||
    normalized.startsWith('no pending work');
  if (!reportsNoWork) return false;

  return (
    normalized.includes('no pending') ||
    normalized.includes('no queued') ||
    normalized.includes('no changes') ||
    normalized.includes('idle')
  );
}
