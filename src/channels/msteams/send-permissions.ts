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
import { normalizeValue } from './utils.js';

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

function resolveChannelConfig(params: {
  teamConfig?: RuntimeMSTeamsTeamConfig;
  channelId?: string | null;
}): RuntimeMSTeamsTeamConfig['channels'][string] | undefined {
  const channelId = normalizeValue(params.channelId);
  return channelId ? params.teamConfig?.channels[channelId] : undefined;
}

function resolveCascaded<T>(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  teamConfig?: RuntimeMSTeamsTeamConfig;
  fallback: T;
  getChannelValue: (
    channelConfig: RuntimeMSTeamsTeamConfig['channels'][string] | undefined,
  ) => T | undefined;
  getTeamValue: (
    teamConfig: RuntimeMSTeamsTeamConfig | undefined,
  ) => T | undefined;
  merge?: (params: {
    channelValue: T | undefined;
    teamValue: T | undefined;
    fallback: T;
  }) => T;
}): T {
  const channelValue = params.getChannelValue(params.channelConfig);
  const teamValue = params.getTeamValue(params.teamConfig);
  if (params.merge) {
    return params.merge({
      channelValue,
      teamValue,
      fallback: params.fallback,
    });
  }
  if (typeof channelValue !== 'undefined') return channelValue;
  if (typeof teamValue !== 'undefined') return teamValue;
  return params.fallback;
}

function resolveEffectiveAllowFrom(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  globalAllowFrom: string[];
  teamConfig?: RuntimeMSTeamsTeamConfig;
}): string[] {
  return resolveCascaded({
    channelConfig: params.channelConfig,
    teamConfig: params.teamConfig,
    fallback: normalizeList(params.globalAllowFrom),
    getChannelValue: (channelConfig) => {
      const allowFrom = normalizeList(channelConfig?.allowFrom);
      return allowFrom.length > 0 ? allowFrom : undefined;
    },
    getTeamValue: (teamConfig) => {
      const allowFrom = normalizeList(teamConfig?.allowFrom);
      return allowFrom.length > 0 ? allowFrom : undefined;
    },
  });
}

function resolveTools(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  teamConfig?: RuntimeMSTeamsTeamConfig;
}): string[] {
  return resolveCascaded({
    channelConfig: params.channelConfig,
    teamConfig: params.teamConfig,
    fallback: [],
    getChannelValue: (channelConfig) => channelConfig?.tools,
    getTeamValue: (teamConfig) => teamConfig?.tools,
    merge: ({ channelValue, teamValue }) =>
      mergeUnique([...(channelValue || []), ...(teamValue || [])]),
  });
}

function resolveRequireMention(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  defaultRequireMention: boolean;
  teamConfig?: RuntimeMSTeamsTeamConfig;
}): boolean {
  return resolveCascaded({
    channelConfig: params.channelConfig,
    teamConfig: params.teamConfig,
    fallback: params.defaultRequireMention,
    getChannelValue: (channelConfig) => channelConfig?.requireMention,
    getTeamValue: (teamConfig) => teamConfig?.requireMention,
  });
}

function resolveReplyStyle(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  defaultReplyStyle: MSTeamsReplyStyle;
  teamConfig?: RuntimeMSTeamsTeamConfig;
}): MSTeamsReplyStyle {
  return resolveCascaded({
    channelConfig: params.channelConfig,
    teamConfig: params.teamConfig,
    fallback: params.defaultReplyStyle,
    getChannelValue: (channelConfig) => channelConfig?.replyStyle,
    getTeamValue: (teamConfig) => teamConfig?.replyStyle,
  });
}

function resolveGroupPolicy(params: {
  channelConfig?: RuntimeMSTeamsTeamConfig['channels'][string];
  defaultGroupPolicy: MSTeamsGroupPolicy;
  teamConfig?: RuntimeMSTeamsTeamConfig;
}): MSTeamsGroupPolicy {
  return resolveCascaded({
    channelConfig: params.channelConfig,
    teamConfig: params.teamConfig,
    fallback: params.defaultGroupPolicy,
    getChannelValue: (channelConfig) => channelConfig?.groupPolicy,
    getTeamValue: (teamConfig) => teamConfig?.groupPolicy,
  });
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
  const channelConfig = resolveChannelConfig({ teamConfig, channelId });
  const effectiveAllowFrom = resolveEffectiveAllowFrom({
    channelConfig,
    globalAllowFrom: snapshot.allowFrom,
    teamConfig,
  });
  const replyStyle = resolveReplyStyle({
    channelConfig,
    defaultReplyStyle: snapshot.replyStyle,
    teamConfig,
  });
  const tools = resolveTools({ channelConfig, teamConfig });

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
          reason: 'sender does not match the effective Teams DM allowlist.',
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
    channelConfig,
    defaultGroupPolicy: snapshot.groupPolicy,
    teamConfig,
  });
  const requireMention = resolveRequireMention({
    channelConfig,
    defaultRequireMention: snapshot.requireMention,
    teamConfig,
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
