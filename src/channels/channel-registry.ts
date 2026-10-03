/**
 * Live channel registrations overlay the descriptor classifier's default info.
 * Kind spellings resolve locally; concrete target facts come from descriptors.
 * This registry does not start transports or choose proactive delivery policy.
 */
import {
  type ChannelInfo,
  type ChannelKind,
  DISCORD_CAPABILITIES,
  DISCORD_WEBHOOK_CAPABILITIES,
  EMAIL_CAPABILITIES,
  IMESSAGE_CAPABILITIES,
  LINE_CAPABILITIES,
  MSTEAMS_CAPABILITIES,
  SIGNAL_CAPABILITIES,
  SKILL_CONFIG_CHANNEL_KINDS,
  type SkillConfigChannelKind,
  SLACK_CAPABILITIES,
  SLACK_WEBHOOK_CAPABILITIES,
  SYSTEM_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
  THREEMA_CAPABILITIES,
  TUI_CAPABILITIES,
  VOICE_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
} from './channel.js';
import { getChannelDescriptorForTarget } from './channel-descriptors.js';

const CHANNEL_CAPABILITIES: Record<ChannelKind, ChannelInfo['capabilities']> = {
  discord: DISCORD_CAPABILITIES,
  discord_webhook: DISCORD_WEBHOOK_CAPABILITIES,
  email: EMAIL_CAPABILITIES,
  heartbeat: SYSTEM_CAPABILITIES,
  imessage: IMESSAGE_CAPABILITIES,
  line: LINE_CAPABILITIES,
  msteams: MSTEAMS_CAPABILITIES,
  scheduler: SYSTEM_CAPABILITIES,
  signal: SIGNAL_CAPABILITIES,
  slack: SLACK_CAPABILITIES,
  slack_webhook: SLACK_WEBHOOK_CAPABILITIES,
  telegram: TELEGRAM_CAPABILITIES,
  threema: THREEMA_CAPABILITIES,
  tui: TUI_CAPABILITIES,
  voice: VOICE_CAPABILITIES,
  whatsapp: WHATSAPP_CAPABILITIES,
};

const CHANNEL_KIND_SET = new Set<ChannelKind>(
  Object.keys(CHANNEL_CAPABILITIES) as ChannelKind[],
);
const SKILL_CONFIG_CHANNEL_KIND_SET = new Set<ChannelKind>(
  SKILL_CONFIG_CHANNEL_KINDS,
);

// Supported input spellings for operator-typed channel kinds (skill
// `channels:`, `--channel`), not compat shims for renamed kinds.
const CHANNEL_KIND_ALIASES: Record<string, ChannelKind> = {
  teams: 'msteams',
  discordwebhook: 'discord_webhook',
  'discord-webhook': 'discord_webhook',
  slackwebhook: 'slack_webhook',
  'slack-webhook': 'slack_webhook',
};

export function normalizeChannelValue(
  value?: string | null,
): string | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeChannelKind(
  kind?: string | null,
): ChannelKind | undefined {
  const normalized = normalizeChannelValue(kind);
  if (!normalized) return undefined;
  if (CHANNEL_KIND_SET.has(normalized as ChannelKind)) {
    return normalized as ChannelKind;
  }
  return CHANNEL_KIND_ALIASES[normalized];
}

function isSkillConfigChannelKind(
  kind: ChannelKind,
): kind is SkillConfigChannelKind {
  return SKILL_CONFIG_CHANNEL_KIND_SET.has(kind);
}

export function normalizeSkillConfigChannelKind(
  kind?: string | null,
): SkillConfigChannelKind | undefined {
  const channelKind = normalizeChannelKind(kind);
  if (!channelKind || !isSkillConfigChannelKind(channelKind)) {
    return undefined;
  }
  return channelKind;
}

const channels = new Map<ChannelKind, ChannelInfo>();

function buildDefaultChannelInfo(kind: ChannelKind): ChannelInfo {
  return {
    kind,
    id: kind,
    capabilities: CHANNEL_CAPABILITIES[kind],
  };
}

function inferChannelKind(channelId?: string | null): ChannelKind | undefined {
  const normalized = String(channelId || '').trim();
  if (!normalized) return undefined;
  const explicitKind = normalizeChannelKind(normalized);
  if (explicitKind) return explicitKind;
  return getChannelDescriptorForTarget(normalized)?.kind;
}

export function registerChannel(info: ChannelInfo): void {
  const kind = normalizeChannelKind(info.kind);
  if (!kind) {
    throw new Error(`Unsupported channel kind: ${info.kind}`);
  }
  channels.set(kind, {
    ...info,
    kind,
    id: String(info.id || kind).trim() || kind,
  });
}

export function unregisterChannel(kind: ChannelKind | string): void {
  const normalized = normalizeChannelKind(kind);
  if (!normalized) return;
  channels.delete(normalized);
}

export function getChannel(
  kind: ChannelKind | string,
): ChannelInfo | undefined {
  const normalized = normalizeChannelKind(kind);
  if (!normalized) return undefined;
  return channels.get(normalized);
}

export function getChannelByContextId(
  channelId: string | null | undefined,
): ChannelInfo | undefined {
  const inferredKind = inferChannelKind(channelId);
  if (!inferredKind) return undefined;
  const registered = channels.get(inferredKind);
  if (registered) return registered;
  const fallback = buildDefaultChannelInfo(inferredKind);
  return {
    ...fallback,
    id: String(channelId || '').trim() || fallback.id,
  };
}

export function listChannels(): ChannelInfo[] {
  return Array.from(channels.values()).sort((a, b) =>
    a.kind.localeCompare(b.kind),
  );
}
