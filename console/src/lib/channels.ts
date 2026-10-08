/**
 * Console naming for external channels: one label, runtime-config section and
 * URL fragment per gateway `ExternalChannelKind`, so a new gateway channel kind
 * fails the console typecheck until it is named here.
 *
 * NOT the channel status catalog (`routes/channels-catalog.ts` derives live
 * status from config); this module holds only static names.
 */
import type { ExternalChannelKind } from '../../../src/channels/channel';
import type { AdminConfig } from '../api/types';

export const CHANNEL_LABELS = {
  discord: 'Discord',
  discord_webhook: 'Discord Incoming Webhook',
  email: 'Email',
  imessage: 'iMessage',
  line: 'LINE',
  msteams: 'Microsoft Teams',
  signal: 'Signal',
  slack: 'Slack',
  slack_webhook: 'Slack Incoming Webhook',
  telegram: 'Telegram',
  threema: 'Threema',
  voice: 'Voice',
  whatsapp: 'WhatsApp',
} as const satisfies Record<ExternalChannelKind, string>;

export const CHANNEL_CONFIG_SECTIONS = {
  discord: 'discord',
  discord_webhook: 'discordWebhook',
  email: 'email',
  imessage: 'imessage',
  line: 'line',
  msteams: 'msteams',
  signal: 'signal',
  slack: 'slack',
  slack_webhook: 'slackWebhook',
  telegram: 'telegram',
  threema: 'threema',
  voice: 'voice',
  whatsapp: 'whatsapp',
} as const satisfies Record<ExternalChannelKind, keyof AdminConfig>;

export function isExternalChannelKind(
  value: string,
): value is ExternalChannelKind {
  return Object.hasOwn(CHANNEL_LABELS, value);
}

export function channelFragment(kind: string): string {
  return kind === 'msteams' ? 'teams' : kind;
}

export function channelKindFromFragment(fragment: string): string {
  return fragment === 'teams' ? 'msteams' : fragment;
}
