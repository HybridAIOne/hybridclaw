import { getConfigSnapshot } from '../../config/config.js';
import { SLACK_WEBHOOK_CAPABILITIES } from '../channel.js';
import { registerChannel, unregisterChannel } from '../channel-registry.js';
import {
  clearSlackWebhookLastSendResults,
  getSlackWebhookLastReachabilityResults,
  getSlackWebhookLastSendResults,
  pingSlackWebhookTarget,
  type SlackWebhookSendResult,
  sendSlackWebhookText,
} from './delivery.js';
import { SLACK_WEBHOOK_DEFAULT_TARGET } from './target.js';

let runtimeInitialized = false;
let shutdownController: AbortController | null = null;

function resolveSlackWebhookConfig() {
  return getConfigSnapshot().slackWebhook;
}

export function hasSlackWebhookTargets(): boolean {
  const config = resolveSlackWebhookConfig();
  return Boolean(config.webhooks[SLACK_WEBHOOK_DEFAULT_TARGET]?.webhookUrl);
}

export async function initSlackWebhook(): Promise<void> {
  if (runtimeInitialized) return;

  const config = resolveSlackWebhookConfig();
  if (!config.enabled) {
    throw new Error(
      'Slack webhook channel disabled: slackWebhook.enabled=false.',
    );
  }
  if (!hasSlackWebhookTargets()) {
    throw new Error('Slack webhook default target is not configured.');
  }

  registerChannel({
    kind: 'slack_webhook',
    id: 'slack_webhook',
    capabilities: SLACK_WEBHOOK_CAPABILITIES,
  });
  shutdownController = new AbortController();
  runtimeInitialized = true;
}

export async function sendToSlackWebhookTarget(
  target: string,
  text: string,
): Promise<void> {
  await sendSlackWebhookText({
    signal: shutdownController?.signal,
    target,
    text,
  });
}

export function getSlackWebhookStatus(): {
  targets: string[];
  lastReachabilityResults: SlackWebhookSendResult[];
  lastSendResults: SlackWebhookSendResult[];
} {
  const config = resolveSlackWebhookConfig();
  return {
    targets: Object.keys(config.webhooks).sort(),
    lastReachabilityResults: getSlackWebhookLastReachabilityResults(),
    lastSendResults: getSlackWebhookLastSendResults(),
  };
}

export async function checkSlackWebhookReachability(): Promise<
  SlackWebhookSendResult[]
> {
  const targets = Object.keys(resolveSlackWebhookConfig().webhooks).sort();
  const results: SlackWebhookSendResult[] = [];
  for (const target of targets) {
    results.push(
      await pingSlackWebhookTarget({
        signal: shutdownController?.signal,
        target,
      }),
    );
  }
  return results;
}

export async function shutdownSlackWebhook(): Promise<void> {
  shutdownController?.abort();
  shutdownController = null;
  unregisterChannel('slack_webhook');
  clearSlackWebhookLastSendResults();
  runtimeInitialized = false;
}
