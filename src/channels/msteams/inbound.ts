import { TurnContext } from 'botbuilder-core';
import type { Activity } from 'botframework-schema';
import { isRegisteredTextCommandName } from '../../command-registry.js';
import { normalizeValue } from './utils.js';

export interface ParsedCommand {
  isCommand: boolean;
  command: string;
  args: string[];
}

export interface MSTeamsActorIdentity {
  userId: string;
  aadObjectId: string | null;
  username: string | null;
  displayName: string | null;
}

function stripHtml(text: string): string {
  return text
    .replace(/<at>.*?<\/at>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:div|p|span|strong|em|b|i|u)>/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function extractTeamsTeamId(activity: Partial<Activity>): string | null {
  const channelData = activity.channelData as
    | { team?: { id?: string | null } }
    | undefined;
  const teamId = normalizeValue(channelData?.team?.id);
  return teamId || null;
}

export function isTeamsDm(activity: Partial<Activity>): boolean {
  const conversationType = normalizeValue(
    activity.conversation?.conversationType,
  ).toLowerCase();
  if (conversationType === 'personal') return true;
  return !extractTeamsTeamId(activity);
}

export function hasBotMention(
  activity: Partial<Activity>,
  recipientId?: string | null,
): boolean {
  const botId = normalizeValue(recipientId);
  if (!botId) return false;
  return TurnContext.getMentions(activity).some((mention) => {
    const mentionedId = normalizeValue(mention.mentioned?.id);
    return Boolean(mentionedId && mentionedId === botId);
  });
}

export function cleanIncomingContent(activity: Partial<Activity>): string {
  const stripped = TurnContext.removeRecipientMention(activity) || '';
  return stripHtml(stripped);
}

export function extractActorIdentity(
  activity: Partial<Activity>,
): MSTeamsActorIdentity {
  const aadObjectId = normalizeValue(
    (activity.from as { aadObjectId?: string | null } | undefined)?.aadObjectId,
  );
  const userId = aadObjectId || normalizeValue(activity.from?.id);
  const username = normalizeValue(activity.from?.name);
  return {
    userId,
    aadObjectId: aadObjectId || null,
    username: username || null,
    displayName: username || null,
  };
}

export function buildSessionIdFromActivity(
  activity: Partial<Activity>,
): string {
  const actor = extractActorIdentity(activity);
  const teamId = extractTeamsTeamId(activity);
  const conversationId = normalizeValue(activity.conversation?.id);
  if (!teamId) {
    return `teams:dm:${actor.userId}`;
  }
  return `teams:${teamId}:${conversationId}`;
}

export function parseCommand(text: string): ParsedCommand {
  const trimmed = normalizeValue(text);
  if (!trimmed.startsWith('/')) {
    return { isCommand: false, command: '', args: [] };
  }
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const command = normalizeValue(parts[0]).toLowerCase();
  if (!command || !isRegisteredTextCommandName(command)) {
    return { isCommand: false, command: '', args: [] };
  }
  return {
    isCommand: true,
    command,
    args: parts.slice(1),
  };
}
