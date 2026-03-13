import { discordAgentPromptAdapter } from './discord/prompt-adapter.js';
import { isEmailAddress } from './email/allowlist.js';
import { emailAgentPromptAdapter } from './email/prompt-adapter.js';
import { isWhatsAppJid } from './whatsapp/phone.js';
import { whatsappAgentPromptAdapter } from './whatsapp/prompt-adapter.js';

const DISCORD_SNOWFLAKE_RE = /^\d{16,22}$/;

export interface ChannelPromptRuntimeInfo {
  channelType?: string;
  channelId?: string;
  guildId?: string | null;
}

export type ChannelAgentPromptAdapter = {
  messageToolHints?: (params: {
    runtimeInfo?: ChannelPromptRuntimeInfo;
  }) => string[];
};

function normalizeLower(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function isWhatsAppContext(runtimeInfo?: ChannelPromptRuntimeInfo): boolean {
  const channelType = normalizeLower(runtimeInfo?.channelType);
  if (channelType) return channelType === 'whatsapp';

  const channelId = normalizeValue(runtimeInfo?.channelId);
  return isWhatsAppJid(channelId);
}

function isDiscordContext(runtimeInfo?: ChannelPromptRuntimeInfo): boolean {
  const channelType = normalizeLower(runtimeInfo?.channelType);
  if (channelType) return channelType === 'discord';

  const channelId = normalizeValue(runtimeInfo?.channelId);
  if (DISCORD_SNOWFLAKE_RE.test(channelId)) return true;
  const guildId = normalizeValue(runtimeInfo?.guildId);
  return DISCORD_SNOWFLAKE_RE.test(guildId);
}

function isEmailContext(runtimeInfo?: ChannelPromptRuntimeInfo): boolean {
  const channelType = normalizeLower(runtimeInfo?.channelType);
  if (channelType) return channelType === 'email';

  const channelId = normalizeValue(runtimeInfo?.channelId);
  return isEmailAddress(channelId);
}

function resolveChannelAgentPromptAdapter(params: {
  runtimeInfo?: ChannelPromptRuntimeInfo;
}): ChannelAgentPromptAdapter | null {
  if (isWhatsAppContext(params.runtimeInfo)) return whatsappAgentPromptAdapter;
  if (isEmailContext(params.runtimeInfo)) return emailAgentPromptAdapter;
  if (isDiscordContext(params.runtimeInfo)) return discordAgentPromptAdapter;
  return null;
}

export function resolveChannelMessageToolHints(params: {
  runtimeInfo?: ChannelPromptRuntimeInfo;
}): string[] {
  const adapter = resolveChannelAgentPromptAdapter(params);
  const resolveHints = adapter?.messageToolHints;
  if (!resolveHints) return [];
  return resolveHints(params)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
