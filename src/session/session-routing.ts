import { buildSessionKey, parseSessionKey } from './session-key.js';

export type SessionDmScope = 'per-channel-peer' | 'per-linked-identity';

export interface SessionRoutingConfig {
  dmScope: SessionDmScope;
  identityLinks: Record<string, string[]>;
}

export interface ResolvedSessionRoutingScope {
  mainSessionKey: string;
  linkedIdentity?: string;
}

function normalizeRoutingToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function normalizeSessionDmScope(
  value: unknown,
  fallback: SessionDmScope,
): SessionDmScope {
  const normalized = normalizeRoutingToken(String(value || ''));
  if (
    normalized === 'per-channel-peer' ||
    normalized === 'per-linked-identity'
  ) {
    return normalized;
  }
  return fallback;
}

export function normalizeIdentityLinkAlias(
  channelKind: string,
  peerId: string,
): string {
  const normalizedChannelKind = normalizeRoutingToken(channelKind);
  const normalizedPeerId = normalizeRoutingToken(peerId);
  if (!normalizedChannelKind || !normalizedPeerId) {
    return '';
  }
  return `${normalizedChannelKind}:${normalizedPeerId}`;
}

export function normalizeSessionIdentityLinks(
  value: unknown,
): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, string[]> = {};
  for (const [rawIdentity, rawAliases] of Object.entries(value)) {
    const identity = normalizeRoutingToken(rawIdentity);
    if (!identity || !Array.isArray(rawAliases)) continue;

    const aliases = [
      ...new Set(
        rawAliases
          .map((entry) => normalizeRoutingToken(String(entry || '')))
          .filter(Boolean),
      ),
    ];
    if (aliases.length === 0) continue;
    normalized[identity] = aliases;
  }
  return normalized;
}

export function resolveLinkedSessionIdentity(
  specificSessionKey: string,
  config: SessionRoutingConfig,
): string | undefined {
  const parsed = parseSessionKey(specificSessionKey);
  if (!parsed || parsed.chatType !== 'dm') return undefined;

  const alias = normalizeIdentityLinkAlias(parsed.channelKind, parsed.peerId);
  if (!alias) return undefined;

  for (const [identity, aliases] of Object.entries(config.identityLinks)) {
    if (aliases.includes(alias)) {
      return identity;
    }
  }
  return undefined;
}

export function resolveSessionRoutingScope(
  specificSessionKey: string,
  config: SessionRoutingConfig,
): ResolvedSessionRoutingScope {
  const parsed = parseSessionKey(specificSessionKey);
  if (!parsed || parsed.chatType !== 'dm') {
    return { mainSessionKey: specificSessionKey };
  }
  if (config.dmScope === 'per-channel-peer') {
    return { mainSessionKey: specificSessionKey };
  }

  const linkedIdentity = resolveLinkedSessionIdentity(
    specificSessionKey,
    config,
  );
  if (!linkedIdentity) {
    return { mainSessionKey: specificSessionKey };
  }

  return {
    mainSessionKey: buildSessionKey(
      parsed.agentId,
      'main',
      'dm',
      linkedIdentity,
    ),
    linkedIdentity,
  };
}
