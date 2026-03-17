import { TurnContext } from 'botbuilder-core';
import type { Activity } from 'botframework-schema';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { isRegisteredTextCommandName } from '../../command-registry.js';
import { buildSessionKey } from '../../session/session-key.js';
import { isRecord, normalizeValue } from './utils.js';

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

const CARD_TEXT_KEYS = new Set([
  'alttext',
  'fallbacktext',
  'label',
  'placeholder',
  'speak',
  'subtitle',
  'text',
  'title',
]);

function stripHtml(text: string): string {
  const blockTags = new Set(['br', 'div', 'p', 'li', 'tr', 'ul', 'ol']);
  let result = '';
  let index = 0;
  let mentionDepth = 0;

  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const end = text.indexOf('-->', index + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', index)) {
      const end = text.indexOf(']]>', index + 9);
      if (mentionDepth === 0) {
        result += text.slice(index + 9, end === -1 ? text.length : end);
      }
      index = end === -1 ? text.length : end + 3;
      continue;
    }

    const current = text[index];
    if (current !== '<') {
      if (mentionDepth === 0) {
        result += current;
      }
      index += 1;
      continue;
    }

    const closeIndex = text.indexOf('>', index + 1);
    if (closeIndex === -1) {
      if (mentionDepth === 0) {
        result += current;
      }
      index += 1;
      continue;
    }

    const rawTag = text.slice(index + 1, closeIndex).trim();
    const isClosingTag = rawTag.startsWith('/');
    const tagName = normalizeValue(
      rawTag.replace(/^\//, '').split(/\s+/, 1)[0],
    ).toLowerCase();

    if (tagName === 'at') {
      mentionDepth = isClosingTag
        ? Math.max(0, mentionDepth - 1)
        : mentionDepth + 1;
      result += ' ';
      index = closeIndex + 1;
      continue;
    }

    if (mentionDepth === 0 && blockTags.has(tagName)) {
      result += tagName === 'br' ? '\n' : ' ';
    } else if (mentionDepth === 0) {
      result += ' ';
    }

    index = closeIndex + 1;
  }

  return result
    .replace(/&#(\d+);/g, (match, codePoint) => {
      const value = Number.parseInt(codePoint, 10);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, codePoint) => {
      const value = Number.parseInt(codePoint, 16);
      return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : match;
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (_match, entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === 'nbsp') return ' ';
      if (normalized === 'amp') return '&';
      if (normalized === 'lt') return '<';
      if (normalized === 'gt') return '>';
      if (normalized === 'quot') return '"';
      return "'";
    })
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function appendUniqueSnippet(target: string[], snippet: string): void {
  const normalized = stripHtml(snippet);
  if (!normalized) return;
  if (target.some((entry) => entry === normalized)) return;
  target.push(normalized);
}

function collectCardText(value: unknown, snippets: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCardText(entry, snippets);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const facts = Array.isArray(value.facts) ? value.facts : [];
  for (const fact of facts) {
    if (!isRecord(fact)) continue;
    const title =
      typeof fact.title === 'string'
        ? stripHtml(fact.title).replace(/[:\s]+$/g, '')
        : '';
    const factValue =
      typeof fact.value === 'string' ? stripHtml(fact.value) : '';
    if (title && factValue) {
      appendUniqueSnippet(snippets, `${title}: ${factValue}`);
    } else if (title) {
      appendUniqueSnippet(snippets, title);
    } else if (factValue) {
      appendUniqueSnippet(snippets, factValue);
    }
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'facts') {
      continue;
    }
    if (typeof fieldValue === 'string') {
      if (!CARD_TEXT_KEYS.has(normalizedKey)) continue;
      appendUniqueSnippet(snippets, fieldValue);
      continue;
    }
    if (
      Array.isArray(fieldValue) ||
      (isRecord(fieldValue) &&
        (normalizedKey === 'body' ||
          normalizedKey === 'columns' ||
          normalizedKey === 'actions' ||
          normalizedKey === 'items' ||
          normalizedKey === 'content' ||
          normalizedKey === 'sections'))
    ) {
      collectCardText(fieldValue, snippets);
    }
  }
}

function extractAttachmentText(activity: Partial<Activity>): string[] {
  const attachments = Array.isArray(activity.attachments)
    ? activity.attachments
    : [];
  const snippets: string[] = [];

  for (const attachment of attachments) {
    const contentType = normalizeValue(attachment.contentType).toLowerCase();
    const content = (attachment as { content?: unknown }).content;
    if (typeof content === 'string') {
      if (contentType.startsWith('text/html')) {
        appendUniqueSnippet(snippets, content);
      }
      continue;
    }
    if (!isRecord(content)) {
      continue;
    }
    if (
      contentType === 'application/vnd.microsoft.card.adaptive' ||
      contentType.startsWith('application/vnd.microsoft.card.') ||
      contentType === 'application/vnd.microsoft.teams.card.o365connector'
    ) {
      collectCardText(content, snippets);
      continue;
    }
    if (contentType.startsWith('text/html')) {
      for (const key of ['content', 'text', 'body']) {
        const value = content[key];
        if (typeof value === 'string') {
          appendUniqueSnippet(snippets, value);
        }
      }
    }
  }

  return snippets;
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

export function extractPrimaryText(activity: Partial<Activity>): string {
  const stripped = TurnContext.removeRecipientMention(activity) || '';
  return stripHtml(stripped);
}

export function cleanIncomingContent(activity: Partial<Activity>): string {
  const parts = [
    extractPrimaryText(activity),
    ...extractAttachmentText(activity),
  ].filter((entry) => entry.length > 0);
  return parts.join('\n\n').trim();
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
  agentId = DEFAULT_AGENT_ID,
): string {
  const actor = extractActorIdentity(activity);
  const teamId = extractTeamsTeamId(activity);
  const conversationId = normalizeValue(activity.conversation?.id);
  if (!teamId) {
    return buildSessionKey(agentId, 'msteams', 'dm', actor.userId);
  }
  return buildSessionKey(agentId, 'msteams', 'channel', conversationId, {
    topicId: teamId,
  });
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
