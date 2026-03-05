import { discordAgentPromptAdapter } from './discord/prompt-adapter.js';

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

function isDiscordContext(runtimeInfo?: ChannelPromptRuntimeInfo): boolean {
  const channelType = normalizeLower(runtimeInfo?.channelType);
  if (channelType) return channelType === 'discord';

  const channelId = normalizeValue(runtimeInfo?.channelId);
  if (DISCORD_SNOWFLAKE_RE.test(channelId)) return true;

  if (runtimeInfo?.guildId === null) return true;
  const guildId = normalizeValue(runtimeInfo?.guildId);
  return DISCORD_SNOWFLAKE_RE.test(guildId);
}

function resolveChannelAgentPromptAdapter(params: {
  runtimeInfo?: ChannelPromptRuntimeInfo;
}): ChannelAgentPromptAdapter | null {
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
