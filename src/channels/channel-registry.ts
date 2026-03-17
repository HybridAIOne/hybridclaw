import {
  type ChannelInfo,
  type ChannelKind,
  DISCORD_CAPABILITIES,
  EMAIL_CAPABILITIES,
  MSTEAMS_CAPABILITIES,
  type SkillConfigChannelKind,
  SYSTEM_CAPABILITIES,
  TUI_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
} from './channel.js';
import { isEmailAddress } from './email/allowlist.js';
import { isWhatsAppJid } from './whatsapp/phone.js';

const DISCORD_SNOWFLAKE_RE = /^\d{16,22}$/;

const CHANNEL_CAPABILITIES: Record<ChannelKind, ChannelInfo['capabilities']> = {
  discord: DISCORD_CAPABILITIES,
  email: EMAIL_CAPABILITIES,
  heartbeat: SYSTEM_CAPABILITIES,
  msteams: MSTEAMS_CAPABILITIES,
  scheduler: SYSTEM_CAPABILITIES,
  tui: TUI_CAPABILITIES,
  whatsapp: WHATSAPP_CAPABILITIES,
};

const CHANNEL_KIND_SET = new Set<ChannelKind>(
  Object.keys(CHANNEL_CAPABILITIES) as ChannelKind[],
);

const CHANNEL_KIND_ALIASES: Record<string, ChannelKind> = {
  teams: 'msteams',
};

// Channel registration is intentionally process-global so prompt rendering and
// runtime delivery share the same live channel inventory. Tests reset it by
// reloading the module.
const channels = new Map<ChannelKind, ChannelInfo>();

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

export function normalizeSkillConfigChannelKind(
  kind?: string | null,
): SkillConfigChannelKind | undefined {
  const channelKind = normalizeChannelKind(kind);
  if (
    channelKind !== 'discord' &&
    channelKind !== 'email' &&
    channelKind !== 'msteams' &&
    channelKind !== 'whatsapp'
  ) {
    return undefined;
  }
  return channelKind;
}

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
  if (
    normalized.startsWith('19:') ||
    normalized.startsWith('teams:') ||
    normalized.includes('@thread.')
  ) {
    return 'msteams';
  }
  if (isWhatsAppJid(normalized)) return 'whatsapp';
  if (isEmailAddress(normalized)) return 'email';
  if (DISCORD_SNOWFLAKE_RE.test(normalized)) return 'discord';
  return undefined;
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
