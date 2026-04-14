import type { ChannelInfo } from './channel.js';
import {
  getChannel,
  getChannelByContextId,
  normalizeChannelValue,
} from './channel-registry.js';
import { discordAgentPromptAdapter } from './discord/prompt-adapter.js';
import { emailAgentPromptAdapter } from './email/prompt-adapter.js';
import { imessageAgentPromptAdapter } from './imessage/prompt-adapter.js';
import { msteamsAgentPromptAdapter } from './msteams/prompt-adapter.js';
import { slackAgentPromptAdapter } from './slack/prompt-adapter.js';
import { telegramAgentPromptAdapter } from './telegram/prompt-adapter.js';
import { whatsappAgentPromptAdapter } from './whatsapp/prompt-adapter.js';

export interface ChannelPromptRuntimeInfo {
  channel?: ChannelInfo;
  channelType?: string;
  channelId?: string;
  guildId?: string | null;
}

export type ChannelAgentPromptAdapter = {
  messageToolHints?: (params: {
    runtimeInfo?: ChannelPromptRuntimeInfo;
  }) => string[];
};

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function resolveRuntimeChannel(
  runtimeInfo?: ChannelPromptRuntimeInfo,
): ChannelInfo | undefined {
  const explicitChannel = runtimeInfo?.channel;
  if (explicitChannel) {
    return explicitChannel;
  }
  const channelType = normalizeChannelValue(runtimeInfo?.channelType);
  if (channelType) {
    const registeredChannel = getChannel(channelType);
    if (registeredChannel) {
      return registeredChannel;
    }
    const inferredChannel = getChannelByContextId(runtimeInfo?.channelId);
    if (inferredChannel?.kind === channelType) {
      return inferredChannel;
    }
    return undefined;
  }
  const channelId = normalizeValue(runtimeInfo?.channelId);
  if (!channelId) return undefined;
  return getChannelByContextId(channelId);
}

function resolveChannelAgentPromptAdapter(params: {
  runtimeInfo?: ChannelPromptRuntimeInfo;
}): ChannelAgentPromptAdapter | null {
  const channel = resolveRuntimeChannel(params.runtimeInfo);
  if (!channel) return null;
  if (channel.kind === 'whatsapp') return whatsappAgentPromptAdapter;
  if (channel.kind === 'email') return emailAgentPromptAdapter;
  if (channel.kind === 'imessage') return imessageAgentPromptAdapter;
  if (channel.kind === 'msteams') return msteamsAgentPromptAdapter;
  if (channel.kind === 'slack') return slackAgentPromptAdapter;
  if (channel.kind === 'telegram') return telegramAgentPromptAdapter;
  if (channel.kind === 'discord') return discordAgentPromptAdapter;
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
