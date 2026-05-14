import { DISCORD_WEBHOOK_CAPABILITIES } from '../channel.js';
import { registerChannel, unregisterChannel } from '../channel-registry.js';
import { resolveDiscordWebhookConfig } from './config.js';
import {
  clearDiscordWebhookRuntimeResults,
  type DiscordWebhookSendResult,
  getDiscordWebhookLastReachabilityResults,
  getDiscordWebhookLastSendResults,
  pingDiscordWebhookTarget,
  sendDiscordWebhookText,
} from './delivery.js';
import { DISCORD_WEBHOOK_DEFAULT_TARGET } from './target.js';

let runtimeInitialized = false;
let shutdownController: AbortController | null = null;

export function hasDiscordWebhookTargets(): boolean {
  const config = resolveDiscordWebhookConfig();
  return Boolean(config.webhooks[DISCORD_WEBHOOK_DEFAULT_TARGET]?.webhookUrl);
}

export async function initDiscordWebhook(): Promise<void> {
  if (runtimeInitialized) return;

  resolveDiscordWebhookConfig({
    requireDefaultTarget: true,
    requireEnabled: true,
  });

  registerChannel({
    kind: 'discord_webhook',
    id: 'discord_webhook',
    capabilities: DISCORD_WEBHOOK_CAPABILITIES,
  });
  shutdownController = new AbortController();
  runtimeInitialized = true;
}

export async function sendToDiscordWebhookTarget(
  target: string,
  text: string,
): Promise<void> {
  await sendDiscordWebhookText({
    signal: shutdownController?.signal,
    target,
    text,
  });
}

export function getDiscordWebhookStatus(): {
  targets: string[];
  lastReachabilityResults: DiscordWebhookSendResult[];
  lastSendResults: DiscordWebhookSendResult[];
} {
  const config = resolveDiscordWebhookConfig();
  return {
    targets: Object.keys(config.webhooks).sort(),
    lastReachabilityResults: getDiscordWebhookLastReachabilityResults(),
    lastSendResults: getDiscordWebhookLastSendResults(),
  };
}

export async function checkDiscordWebhookReachability(): Promise<
  DiscordWebhookSendResult[]
> {
  const targets = Object.keys(resolveDiscordWebhookConfig().webhooks).sort();
  return Promise.all(
    targets.map((target) =>
      pingDiscordWebhookTarget({
        signal: shutdownController?.signal,
        target,
      }),
    ),
  );
}

export async function shutdownDiscordWebhook(): Promise<void> {
  shutdownController?.abort();
  shutdownController = null;
  unregisterChannel('discord_webhook');
  clearDiscordWebhookRuntimeResults();
  runtimeInitialized = false;
}
