/**
 * slack proactive delivery reports transport failures to the gateway.
 * Target validation and quiet-hour queues belong to proactive-dispatch;
 * this sender neither reclassifies targets nor falls back to a local inbox.
 */
import {
  getConfigSnapshot,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
} from '../../config/config.js';
import type { ArtifactMetadata } from '../../types/execution.js';
import type { ProactiveDeliveryOutcome } from '../channel-descriptor.js';
import { slackRuntimeLoader } from '../channel-runtime-loaders.js';

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

export async function sendProactive(
  channelId: string,
  text: string,
  _source: string,
  artifacts?: ArtifactMetadata[],
): Promise<ProactiveDeliveryOutcome> {
  const slackConfigured =
    getConfigSnapshot().slack.enabled &&
    Boolean(trimValue(SLACK_BOT_TOKEN)) &&
    Boolean(trimValue(SLACK_APP_TOKEN));
  if (!slackConfigured) {
    return { status: 'failed', reason: 'Slack is not configured' };
  }

  const slack = await slackRuntimeLoader.load();
  if (text.trim()) {
    await slack.sendToSlackTarget(channelId, text);
  }
  for (const artifact of artifacts || []) {
    await slack.sendSlackFileToTarget({
      target: channelId,
      filePath: artifact.path,
      filename: artifact.filename,
    });
  }
  return { status: 'delivered' };
}
