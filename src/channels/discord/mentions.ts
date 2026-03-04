import type { Message as DiscordMessage } from 'discord.js';

import { logger } from '../../logger.js';

export interface MentionLookup {
  byAlias: Map<string, Set<string>>;
}

export interface MentionAliasHint {
  alias: string;
  userId: string;
}

export function normalizeMentionAlias(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim().replace(/^@+/, '');
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (lowered === 'everyone' || lowered === 'here') return '';
  if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(trimmed)) return '';
  return lowered;
}

export function addMentionAlias(lookup: MentionLookup, rawAlias: string | null | undefined, userId: string): void {
  const alias = normalizeMentionAlias(rawAlias);
  if (!alias) return;
  let ids = lookup.byAlias.get(alias);
  if (!ids) {
    ids = new Set<string>();
    lookup.byAlias.set(alias, ids);
  }
  ids.add(userId);
}

export function extractMentionAliasHints(text: string): MentionAliasHint[] {
  if (!text) return [];

  const hints = new Map<string, MentionAliasHint>();
  const collect = (rawAlias: string | null | undefined, rawUserId: string | null | undefined): void => {
    const userId = (rawUserId || '').trim();
    if (!/^\d{16,22}$/.test(userId)) return;
    const alias = normalizeMentionAlias(rawAlias);
    if (!alias) return;
    const key = `${alias}:${userId}`;
    if (!hints.has(key)) hints.set(key, { alias, userId });
  };

  const aliasToId = /(^|[\s,;:.!?])@?([\p{L}\p{N}._-]{2,32})\s*(?:ist|is|=|->|=>|means|heißt)\s*(?:<@!?(\d{16,22})>|(\d{16,22}))/giu;
  let match: RegExpExecArray | null;
  while ((match = aliasToId.exec(text)) !== null) {
    collect(match[2], match[3] || match[4]);
  }

  const idToAlias = /(?:<@!?(\d{16,22})>|(\d{16,22}))\s*(?:ist|is|=|->|=>|means|heißt)\s*@?([\p{L}\p{N}._-]{2,32})/giu;
  while ((match = idToAlias.exec(text)) !== null) {
    collect(match[3], match[1] || match[2]);
  }

  return Array.from(hints.values());
}

export function rewriteUserMentions(text: string, lookup: MentionLookup): string {
  if (!text) return text;
  if (!lookup.byAlias.size) return text;
  return text.replace(/(^|[\s([{:>])@([\p{L}\p{N}._-]{2,32})\b/gu, (full, prefix: string, rawAlias: string) => {
    const alias = normalizeMentionAlias(rawAlias);
    if (!alias) return full;
    const ids = lookup.byAlias.get(alias);
    if (!ids || ids.size !== 1) return full;
    const [id] = Array.from(ids);
    if (!id) return full;
    return `${prefix}<@${id}>`;
  });
}

function extractMentionAliases(text: string): string[] {
  if (!text) return [];
  const aliases = new Set<string>();
  const re = /(^|[\s([{:>])@([\p{L}\p{N}._-]{2,32})\b/gu;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const alias = normalizeMentionAlias(match[2]);
    if (!alias) continue;
    aliases.add(alias);
    if (aliases.size >= 8) break;
  }
  return Array.from(aliases);
}

async function enrichMentionLookupFromGuild(
  msg: DiscordMessage,
  lookup: MentionLookup,
  aliases: string[],
): Promise<void> {
  if (!msg.guild || aliases.length === 0) return;

  for (const alias of aliases) {
    if (lookup.byAlias.has(alias)) continue;
    try {
      const members = await msg.guild.members.search({ query: alias, limit: 5 });
      const exactMatches = Array.from(members.values()).filter((member) => {
        const username = normalizeMentionAlias(member.user?.username || '');
        const displayName = normalizeMentionAlias(member.displayName || '');
        return username === alias || displayName === alias;
      });
      if (exactMatches.length !== 1) continue;
      const match = exactMatches[0];
      addMentionAlias(lookup, alias, match.id);
      addMentionAlias(lookup, match.user?.username || '', match.id);
      addMentionAlias(lookup, match.displayName || '', match.id);
    } catch (error) {
      logger.debug(
        { error, guildId: msg.guild.id, alias },
        'Failed to resolve guild member alias for mention rewrite',
      );
    }
  }
}

export async function rewriteUserMentionsForMessage(
  text: string,
  msg: DiscordMessage,
  lookup: MentionLookup,
): Promise<string> {
  const aliases = extractMentionAliases(text);
  if (aliases.length > 0) {
    await enrichMentionLookupFromGuild(msg, lookup, aliases);
  }
  return rewriteUserMentions(text, lookup);
}
