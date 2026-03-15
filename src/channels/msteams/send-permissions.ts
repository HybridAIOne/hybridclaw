import {
  MSTEAMS_ALLOW_FROM,
  MSTEAMS_DANGEROUSLY_ALLOW_NAME_MATCHING,
  MSTEAMS_DM_POLICY,
  MSTEAMS_GROUP_POLICY,
  MSTEAMS_REPLY_STYLE,
  MSTEAMS_REQUIRE_MENTION,
  MSTEAMS_TEAMS,
} from '../../config/config.js';
import type {
  MSTeamsDmPolicy,
  MSTeamsGroupPolicy,
  MSTeamsReplyStyle,
  RuntimeMSTeamsTeamConfig,
} from '../../config/runtime-config.js';

export interface MSTeamsPermissionSnapshot {
  groupPolicy: MSTeamsGroupPolicy;
  dmPolicy: MSTeamsDmPolicy;
  allowFrom: string[];
  teams: Record<string, RuntimeMSTeamsTeamConfig>;
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
  dangerouslyAllowNameMatching: boolean;
}

export interface MSTeamsActorIdentity {
  userId: string;
  aadObjectId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

export interface ResolveMSTeamsChannelPolicyParams {
  isDm: boolean;
  teamId?: string | null;
  channelId?: string | null;
  actor: MSTeamsActorIdentity;
}

export interface ResolveMSTeamsChannelPolicyResult {
  allowed: boolean;
  reason?: string;
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
  tools: string[];
  effectiveAllowFrom: string[];
  matchedAllowFrom?: string;
  groupPolicy?: MSTeamsGroupPolicy;
  dmPolicy?: MSTeamsDmPolicy;
}

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function normalizeLower(value: string | null | undefined): string {
  return normalizeValue(value).toLowerCase();
}

function normalizeList(values: string[] | undefined): string[] {
  return (values || []).map((entry) => normalizeValue(entry)).filter(Boolean);
}

function mergeUnique(values: string[]): string[] {
  return [
    ...new Set(values.map((entry) => normalizeValue(entry)).filter(Boolean)),
  ];
}

function resolveEffectiveAllowFrom(params: {
  globalAllowFrom: string[];
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): string[] {
  const channelId = normalizeValue(params.channelId);
  const channelConfig = channelId
    ? params.teamConfig?.channels[channelId]
    : undefined;
  const channelAllowFrom = normalizeList(channelConfig?.allowFrom);
  if (channelAllowFrom.length > 0) return channelAllowFrom;
  const teamAllowFrom = normalizeList(params.teamConfig?.allowFrom);
  if (teamAllowFrom.length > 0) return teamAllowFrom;
  return normalizeList(params.globalAllowFrom);
}

function resolveTools(params: {
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): string[] {
  const channelId = normalizeValue(params.channelId);
  const channelConfig = channelId
    ? params.teamConfig?.channels[channelId]
    : undefined;
  return mergeUnique([
    ...(channelConfig?.tools || []),
    ...(params.teamConfig?.tools || []),
  ]);
}

function resolveRequireMention(params: {
  defaultRequireMention: boolean;
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): boolean {
  const channelId = normalizeValue(params.channelId);
  const channelConfig = channelId
    ? params.teamConfig?.channels[channelId]
    : undefined;
  if (typeof channelConfig?.requireMention === 'boolean') {
    return channelConfig.requireMention;
  }
  if (typeof params.teamConfig?.requireMention === 'boolean') {
    return params.teamConfig.requireMention;
  }
  return params.defaultRequireMention;
}

function resolveReplyStyle(params: {
  defaultReplyStyle: MSTeamsReplyStyle;
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): MSTeamsReplyStyle {
  const channelId = normalizeValue(params.channelId);
  const channelConfig = channelId
    ? params.teamConfig?.channels[channelId]
    : undefined;
  return (
    channelConfig?.replyStyle ||
    params.teamConfig?.replyStyle ||
    params.defaultReplyStyle
  );
}

function resolveGroupPolicy(params: {
  defaultGroupPolicy: MSTeamsGroupPolicy;
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): MSTeamsGroupPolicy {
  const channelId = normalizeValue(params.channelId);
  const channelConfig = channelId
    ? params.teamConfig?.channels[channelId]
    : undefined;
  return (
    channelConfig?.groupPolicy ||
    params.teamConfig?.groupPolicy ||
    params.defaultGroupPolicy
  );
}

function matchesAllowEntry(params: {
  entry: string;
  actor: MSTeamsActorIdentity;
  dangerouslyAllowNameMatching: boolean;
}): boolean {
  const normalizedEntry = normalizeLower(params.entry);
  if (!normalizedEntry) return false;

  const actorIds = [
    normalizeLower(params.actor.aadObjectId),
    normalizeLower(params.actor.userId),
  ].filter(Boolean);
  if (actorIds.includes(normalizedEntry)) return true;

  if (!params.dangerouslyAllowNameMatching) return false;
  const actorNames = [
    normalizeLower(params.actor.displayName),
    normalizeLower(params.actor.username),
  ].filter(Boolean);
  return actorNames.includes(normalizedEntry);
}

function resolveAllowlistMatch(params: {
  allowFrom: string[];
  actor: MSTeamsActorIdentity;
  dangerouslyAllowNameMatching: boolean;
}): string | null {
  const normalizedAllowFrom = normalizeList(params.allowFrom);
  for (const entry of normalizedAllowFrom) {
    if (
      matchesAllowEntry({
        entry,
        actor: params.actor,
        dangerouslyAllowNameMatching: params.dangerouslyAllowNameMatching,
      })
    ) {
      return entry;
    }
  }
  return null;
}

export function resolveMSTeamsChannelPolicyFromSnapshot(
  snapshot: MSTeamsPermissionSnapshot,
  params: ResolveMSTeamsChannelPolicyParams,
): ResolveMSTeamsChannelPolicyResult {
  const teamId = normalizeValue(params.teamId);
  const channelId = normalizeValue(params.channelId);
  const teamConfig = teamId ? snapshot.teams[teamId] : undefined;
  const effectiveAllowFrom = resolveEffectiveAllowFrom({
    globalAllowFrom: snapshot.allowFrom,
    teamConfig,
    channelId,
  });
  const replyStyle = resolveReplyStyle({
    defaultReplyStyle: snapshot.replyStyle,
    teamConfig,
    channelId,
  });
  const tools = resolveTools({ teamConfig, channelId });

  if (params.isDm) {
    if (snapshot.dmPolicy === 'disabled') {
      return {
        allowed: false,
        reason: 'msteams.dmPolicy is disabled.',
        requireMention: false,
        replyStyle,
        tools,
        effectiveAllowFrom,
        dmPolicy: snapshot.dmPolicy,
      };
    }

    const matchedAllowFrom = resolveAllowlistMatch({
      allowFrom: effectiveAllowFrom,
      actor: params.actor,
      dangerouslyAllowNameMatching: snapshot.dangerouslyAllowNameMatching,
    });

    if (effectiveAllowFrom.length > 0 || snapshot.dmPolicy !== 'open') {
      if (!matchedAllowFrom) {
        return {
          allowed: false,
          reason:
            snapshot.dmPolicy === 'pairing'
              ? 'msteams.dmPolicy=pairing currently uses the allowFrom gate until a pairing store exists.'
              : 'sender does not match the effective Teams DM allowlist.',
          requireMention: false,
          replyStyle,
          tools,
          effectiveAllowFrom,
          dmPolicy: snapshot.dmPolicy,
        };
      }
      return {
        allowed: true,
        requireMention: false,
        replyStyle,
        tools,
        effectiveAllowFrom,
        matchedAllowFrom,
        dmPolicy: snapshot.dmPolicy,
      };
    }

    return {
      allowed: true,
      requireMention: false,
      replyStyle,
      tools,
      effectiveAllowFrom,
      dmPolicy: snapshot.dmPolicy,
    };
  }

  const groupPolicy = resolveGroupPolicy({
    defaultGroupPolicy: snapshot.groupPolicy,
    teamConfig,
    channelId,
  });
  const requireMention = resolveRequireMention({
    defaultRequireMention: snapshot.requireMention,
    teamConfig,
    channelId,
  });

  if (groupPolicy === 'disabled') {
    return {
      allowed: false,
      reason: 'msteams.groupPolicy is disabled for this team/channel.',
      requireMention,
      replyStyle,
      tools,
      effectiveAllowFrom,
      groupPolicy,
    };
  }

  const matchedAllowFrom = resolveAllowlistMatch({
    allowFrom: effectiveAllowFrom,
    actor: params.actor,
    dangerouslyAllowNameMatching: snapshot.dangerouslyAllowNameMatching,
  });
  if (effectiveAllowFrom.length > 0 || groupPolicy === 'allowlist') {
    if (!matchedAllowFrom) {
      return {
        allowed: false,
        reason: 'sender does not match the effective Teams allowlist.',
        requireMention,
        replyStyle,
        tools,
        effectiveAllowFrom,
        groupPolicy,
      };
    }
  }

  return {
    allowed: true,
    requireMention,
    replyStyle,
    tools,
    effectiveAllowFrom,
    ...(matchedAllowFrom ? { matchedAllowFrom } : {}),
    groupPolicy,
  };
}

export function resolveMSTeamsChannelPolicy(
  params: ResolveMSTeamsChannelPolicyParams,
): ResolveMSTeamsChannelPolicyResult {
  return resolveMSTeamsChannelPolicyFromSnapshot(
    {
      groupPolicy: MSTEAMS_GROUP_POLICY,
      dmPolicy: MSTEAMS_DM_POLICY,
      allowFrom: MSTEAMS_ALLOW_FROM,
      teams: MSTEAMS_TEAMS,
      requireMention: MSTEAMS_REQUIRE_MENTION,
      replyStyle: MSTEAMS_REPLY_STYLE,
      dangerouslyAllowNameMatching: MSTEAMS_DANGEROUSLY_ALLOW_NAME_MATCHING,
    },
    params,
  );
}
