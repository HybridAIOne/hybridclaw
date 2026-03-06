import {
  DISCORD_GUILDS,
  DISCORD_SEND_ALLOWED_CHANNEL_IDS,
  DISCORD_SEND_POLICY,
} from '../../config/config.js';
import type {
  RuntimeConfig,
  RuntimeDiscordGuildConfig,
} from '../../config/runtime-config.js';

export interface DiscordSendPermissionSnapshot {
  sendPolicy: RuntimeConfig['discord']['sendPolicy'];
  sendAllowedChannelIds: string[];
  guilds: Record<string, RuntimeDiscordGuildConfig>;
}

export interface ResolveSendAllowedParams {
  channelId: string;
  guildId?: string | null;
  requestingUserId?: string | null;
  requestingRoleIds?: string[];
}

export interface ResolveSendAllowedResult {
  allowed: boolean;
  reason?: string;
}

function normalizeId(rawValue: string | null | undefined): string {
  return String(rawValue || '').trim();
}

function normalizeIdList(values: string[] | undefined): Set<string> {
  return new Set(
    (values || []).map((entry) => normalizeId(entry)).filter(Boolean),
  );
}

function resolveGuildAndChannelConfig(
  guilds: Record<string, RuntimeDiscordGuildConfig>,
  guildId: string,
  channelId: string,
): {
  guildConfig: RuntimeDiscordGuildConfig | undefined;
  channelConfig: RuntimeDiscordGuildConfig['channels'][string] | undefined;
} {
  const guildConfig = guilds[guildId];
  const channelConfig = guildConfig?.channels[channelId];
  return { guildConfig, channelConfig };
}

function resolveActorAllowlistState(params: {
  guilds: Record<string, RuntimeDiscordGuildConfig>;
  guildId: string;
  channelId: string;
  requestingUserId: string;
  requestingRoleIds: string[];
}): ResolveSendAllowedResult | null {
  const { guildConfig, channelConfig } = resolveGuildAndChannelConfig(
    params.guilds,
    params.guildId,
    params.channelId,
  );
  const allowedUsers = normalizeIdList(
    channelConfig?.sendAllowedUserIds ?? guildConfig?.sendAllowedUserIds,
  );
  const allowedRoles = normalizeIdList(
    channelConfig?.sendAllowedRoleIds ?? guildConfig?.sendAllowedRoleIds,
  );

  if (allowedUsers.size === 0 && allowedRoles.size === 0) return null;

  if (!params.requestingUserId && allowedUsers.size > 0) {
    return {
      allowed: false,
      reason:
        'sendAllowedUserIds is configured but no requestingUserId was provided.',
    };
  }

  if (params.requestingUserId && allowedUsers.has(params.requestingUserId)) {
    return { allowed: true };
  }

  if (allowedRoles.size === 0) {
    return {
      allowed: false,
      reason: `requesting user ${params.requestingUserId || '(unknown)'} is not in sendAllowedUserIds.`,
    };
  }

  if (params.requestingRoleIds.length === 0) {
    return {
      allowed: false,
      reason:
        'sendAllowedRoleIds is configured but requestingRoleIds were not provided.',
    };
  }

  const matchedRole = params.requestingRoleIds.find((roleId) =>
    allowedRoles.has(roleId),
  );
  if (matchedRole) return { allowed: true };

  return {
    allowed: false,
    reason: `requesting user ${params.requestingUserId || '(unknown)'} does not match send allowlist.`,
  };
}

export function resolveSendAllowedFromSnapshot(
  snapshot: DiscordSendPermissionSnapshot,
  params: ResolveSendAllowedParams,
): ResolveSendAllowedResult {
  const channelId = normalizeId(params.channelId);
  if (!channelId) {
    return { allowed: false, reason: 'channelId is required.' };
  }

  if (snapshot.sendPolicy === 'disabled') {
    return { allowed: false, reason: 'discord.sendPolicy is disabled.' };
  }

  const allowedChannels = normalizeIdList(snapshot.sendAllowedChannelIds);
  const channelIsInGlobalAllowlist =
    allowedChannels.size > 0 && allowedChannels.has(channelId);
  if (allowedChannels.size > 0 && !channelIsInGlobalAllowlist) {
    return {
      allowed: false,
      reason: `channel ${channelId} is not in discord.sendAllowedChannelIds.`,
    };
  }

  const guildId = normalizeId(params.guildId);
  if (snapshot.sendPolicy === 'allowlist' && !channelIsInGlobalAllowlist) {
    if (!guildId) {
      return {
        allowed: false,
        reason:
          'discord.sendPolicy=allowlist requires guildId unless channel is globally allowlisted.',
      };
    }

    const { guildConfig, channelConfig } = resolveGuildAndChannelConfig(
      snapshot.guilds,
      guildId,
      channelId,
    );
    if (!guildConfig) {
      return {
        allowed: false,
        reason: `guild ${guildId} is not configured under discord.guilds.`,
      };
    }
    if (!channelConfig) {
      return {
        allowed: false,
        reason: `channel ${channelId} is not configured under discord.guilds.${guildId}.channels.`,
      };
    }
    if (channelConfig.allowSend === false) {
      return {
        allowed: false,
        reason: `channel ${channelId} explicitly disables outbound sends.`,
      };
    }
  }

  if (guildId) {
    const actorDecision = resolveActorAllowlistState({
      guilds: snapshot.guilds,
      guildId,
      channelId,
      requestingUserId: normalizeId(params.requestingUserId),
      requestingRoleIds: Array.from(
        normalizeIdList(params.requestingRoleIds || []),
      ),
    });
    if (actorDecision) return actorDecision;
  }

  return { allowed: true };
}

export function resolveSendAllowed(
  params: ResolveSendAllowedParams,
): ResolveSendAllowedResult {
  return resolveSendAllowedFromSnapshot(
    {
      sendPolicy: DISCORD_SEND_POLICY,
      sendAllowedChannelIds: DISCORD_SEND_ALLOWED_CHANNEL_IDS,
      guilds: DISCORD_GUILDS,
    },
    params,
  );
}
