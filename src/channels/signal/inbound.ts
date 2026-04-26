import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type { RuntimeSignalConfig } from '../../config/runtime-config.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { SignalEnvelope, SignalSentSyncMessage } from './api.js';
import { buildSignalChannelId } from './target.js';

export interface ProcessedSignalInbound {
  sessionId: string;
  guildId: null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  isGroup: boolean;
  isNoteToSelf: boolean;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return trimmed.toLowerCase();
}

function normalizeAllowList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeIdentity(value))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function matchesAllowList(
  list: string[],
  candidates: Array<string | null | undefined>,
): boolean {
  if (list.includes('*')) return true;
  for (const candidate of candidates) {
    const normalized = normalizeIdentity(candidate);
    if (normalized && list.includes(normalized)) return true;
  }
  return false;
}

export function evaluateSignalAccessPolicy(params: {
  dmPolicy: RuntimeSignalConfig['dmPolicy'];
  groupPolicy: RuntimeSignalConfig['groupPolicy'];
  allowFrom: string[];
  groupAllowFrom: string[];
  isGroup: boolean;
  senderNumber?: string | null;
  senderUuid?: string | null;
}): { allowed: boolean } {
  const allowFrom = normalizeAllowList(params.allowFrom);
  const groupAllowFrom =
    params.groupAllowFrom.length > 0
      ? normalizeAllowList(params.groupAllowFrom)
      : allowFrom;
  const candidates = [params.senderNumber, params.senderUuid];

  if (params.isGroup) {
    if (params.groupPolicy === 'disabled') return { allowed: false };
    if (params.groupPolicy === 'open') return { allowed: true };
    return { allowed: matchesAllowList(groupAllowFrom, candidates) };
  }
  if (params.dmPolicy === 'disabled') return { allowed: false };
  if (params.dmPolicy === 'open') return { allowed: true };
  return { allowed: matchesAllowList(allowFrom, candidates) };
}

function buildSignalDisplayName(envelope: SignalEnvelope): string {
  const name = String(envelope.sourceName || '').trim();
  if (name) return name;
  const number = String(envelope.sourceNumber || '').trim();
  if (number) return number;
  const uuid = String(envelope.sourceUuid || '').trim();
  if (uuid) return uuid;
  return String(envelope.source || '').trim() || 'unknown';
}

function normalizeOptionalSignalIdentity(
  value: string | null | undefined,
): string {
  return String(value || '').trim();
}

function collectSentSyncDestinations(
  sentMessage: SignalSentSyncMessage,
): string[] {
  const destinations = [
    sentMessage.destination,
    sentMessage.destinationNumber,
    sentMessage.destinationUuid,
    ...(Array.isArray(sentMessage.destinations)
      ? sentMessage.destinations
      : []),
  ];
  return destinations
    .map((value) => normalizeOptionalSignalIdentity(value))
    .filter((value) => value.length > 0);
}

function sentSyncTargetsOwnAccount(params: {
  sentMessage: SignalSentSyncMessage;
  ownAccount: string;
}): boolean {
  const own = normalizeIdentity(params.ownAccount);
  if (!own) return false;
  return collectSentSyncDestinations(params.sentMessage).some(
    (destination) => normalizeIdentity(destination) === own,
  );
}

function resolveSignalMessagePayload(params: {
  envelope: SignalEnvelope;
  ownAccount: string;
}): {
  message: string | null | undefined;
  groupId: string;
  isNoteToSelfSync: boolean;
} | null {
  const dataMessage = params.envelope.dataMessage;
  if (dataMessage) {
    return {
      message: dataMessage.message,
      groupId: dataMessage.groupInfo?.groupId
        ? String(dataMessage.groupInfo.groupId).trim()
        : '',
      isNoteToSelfSync: false,
    };
  }

  const sentMessage = params.envelope.syncMessage?.sentMessage;
  if (!sentMessage) return null;
  if (
    !params.ownAccount ||
    !sentSyncTargetsOwnAccount({
      sentMessage,
      ownAccount: params.ownAccount,
    })
  ) {
    return null;
  }
  if (Number(params.envelope.sourceDevice || 0) !== 1) return null;

  return {
    message: sentMessage.message,
    groupId: '',
    isNoteToSelfSync: true,
  };
}

export function processInboundSignalMessage(params: {
  config: RuntimeSignalConfig;
  envelope: SignalEnvelope;
  ownAccount?: string | null;
  agentId?: string;
}): ProcessedSignalInbound | null {
  const ownAccount = String(params.ownAccount || '').trim();
  const senderNumber = String(params.envelope.sourceNumber || '').trim();
  const senderUuid = String(params.envelope.sourceUuid || '').trim();
  const payload = resolveSignalMessagePayload({
    envelope: params.envelope,
    ownAccount,
  });
  if (!payload) return null;

  if (
    !payload.isNoteToSelfSync &&
    ownAccount &&
    (senderNumber === ownAccount || senderUuid === ownAccount)
  ) {
    return null;
  }

  const text = String(payload.message || '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return null;

  const groupId = payload.groupId;
  const isGroup = Boolean(groupId);

  const access = evaluateSignalAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    isGroup,
    senderNumber,
    senderUuid,
  });
  if (!access.allowed) return null;

  const recipient = isGroup
    ? `group:${groupId}`
    : senderNumber || senderUuid || params.envelope.source;
  if (!recipient) return null;

  const channelId = buildSignalChannelId(recipient);
  const userId = senderUuid || senderNumber || params.envelope.source;

  return {
    sessionId: buildSessionKey(
      params.agentId || DEFAULT_AGENT_ID,
      'signal',
      isGroup ? 'group' : 'dm',
      channelId,
    ),
    guildId: null,
    channelId,
    userId,
    username: buildSignalDisplayName(params.envelope),
    content: text,
    isGroup,
    isNoteToSelf: payload.isNoteToSelfSync,
  };
}
