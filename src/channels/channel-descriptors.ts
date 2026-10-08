/**
 * The channel table is the single dispatch source for concrete external targets.
 * Unlike channel-registry, it does not track live runtimes or accept kind aliases
 * as destinations. Classification alone never loads an SDK or starts a channel.
 */
import type {
  ChannelKind,
  ChannelTargetKind,
  ExternalChannelKind,
} from './channel.js';
import type { ChannelDescriptor } from './channel-descriptor.js';
import { descriptor as discord } from './discord/descriptor.js';
import { descriptor as discordWebhook } from './discord-webhook/descriptor.js';
import { descriptor as email } from './email/descriptor.js';
import { descriptor as imessage } from './imessage/descriptor.js';
import { descriptor as line } from './line/descriptor.js';
import { descriptor as msteams } from './msteams/descriptor.js';
import { descriptor as signal } from './signal/descriptor.js';
import { descriptor as slack } from './slack/descriptor.js';
import { descriptor as slackWebhook } from './slack-webhook/descriptor.js';
import { descriptor as telegram } from './telegram/descriptor.js';
import { descriptor as threema } from './threema/descriptor.js';
import { descriptor as voice } from './voice/descriptor.js';
import { descriptor as whatsapp } from './whatsapp/descriptor.js';

export const CHANNEL_DESCRIPTORS: Record<
  ExternalChannelKind,
  ChannelDescriptor
> = {
  [discord.kind]: discord,
  [discordWebhook.kind]: discordWebhook,
  [msteams.kind]: msteams,
  [signal.kind]: signal,
  [threema.kind]: threema,
  [slackWebhook.kind]: slackWebhook,
  [slack.kind]: slack,
  [email.kind]: email,
  [telegram.kind]: telegram,
  [line.kind]: line,
  [whatsapp.kind]: whatsapp,
  [voice.kind]: voice,
  [imessage.kind]: imessage,
};

// Email's broad address matcher also accepts transport JIDs; specific targets win.
const targetDescriptors = Object.values(CHANNEL_DESCRIPTORS).sort(
  (left, right) =>
    Number(left.kind === 'email') - Number(right.kind === 'email'),
);

export function getChannelDescriptorForTarget(
  target: string,
): ChannelDescriptor | undefined {
  const normalized = target.trim();
  if (!normalized) return undefined;
  return targetDescriptors.find((descriptor) =>
    descriptor.matchesTarget(normalized),
  );
}

export function resolveChannelTargetKind(
  target?: string | null,
): ChannelTargetKind | undefined {
  const normalized = target?.trim();
  if (!normalized) return undefined;
  switch (normalized) {
    case 'heartbeat':
    case 'scheduler':
    case 'tui':
    case 'web':
    case 'cli':
      return normalized;
  }
  return getChannelDescriptorForTarget(normalized)?.kind;
}

export function getChannelDescriptor(
  kind: ChannelKind,
): ChannelDescriptor | undefined {
  return Object.hasOwn(CHANNEL_DESCRIPTORS, kind)
    ? CHANNEL_DESCRIPTORS[kind as ExternalChannelKind]
    : undefined;
}
