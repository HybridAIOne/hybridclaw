import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import type {
  RuntimeSlackConfig,
  SlackDmPolicy,
  SlackGroupPolicy,
  SlackReplyStyle,
} from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import {
  resolveManagedTempMediaDir,
  SLACK_MEDIA_TMP_PREFIX,
} from '../../media/managed-temp-media.js';
import { buildSessionKey, parseSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import {
  buildSlackChannelTarget,
  normalizeSlackThreadTs,
  normalizeSlackUserId,
  parseSlackChannelTarget,
} from './target.js';

const SLACK_ALLOWED_FILE_HOSTS = [
  /\.slack\.com$/i,
  /\.slack-edge\.com$/i,
  /\.slack-files\.com$/i,
] as const;

export interface SlackMessageEvent {
  type?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
  team?: string;
  files?: unknown;
}

export interface SlackFileEvent {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackAccessDecision {
  allowed: boolean;
  isDm: boolean;
}

export interface SlackInboundRouting {
  sessionId: string;
  channelId: string;
  guildId: string | null;
  userId: string;
  target: string;
  isDm: boolean;
  threadTs: string | null;
  replyStyle: SlackReplyStyle;
}

export interface ProcessedSlackInbound extends SlackInboundRouting {
  content: string;
  media: MediaContextItem[];
}

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function normalizeAllowEntry(value: string): string | null {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;
  if (trimmed === '*') return '*';
  return normalizeSlackUserId(trimmed);
}

function matchesAllowList(list: string[], userId: string): boolean {
  const normalized = list
    .map((entry) => normalizeAllowEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (normalized.includes('*')) return true;
  return normalized.includes(userId);
}

export function isSlackSessionId(value: string | null | undefined): boolean {
  const parsed = parseSessionKey(String(value || '').trim());
  return parsed?.channelKind === 'slack';
}

function isAllowedSlackFileUrl(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return SLACK_ALLOWED_FILE_HOSTS.some((pattern) =>
      pattern.test(url.hostname),
    );
  } catch {
    return false;
  }
}

async function downloadSlackInboundMedia(params: {
  files: SlackFileEvent[];
  botToken: string;
  mediaMaxMb: number;
}): Promise<MediaContextItem[]> {
  const botToken = trimValue(params.botToken);
  if (!botToken || params.files.length === 0) return [];

  const maxBytes = Math.max(1, params.mediaMaxMb) * 1024 * 1024;
  const accepted = params.files.filter((file) => {
    const size =
      typeof file.size === 'number' && Number.isFinite(file.size)
        ? file.size
        : 0;
    return size > 0 && size <= maxBytes;
  });
  if (accepted.length === 0) return [];

  let tempDir: string | null = null;
  const media: MediaContextItem[] = [];

  try {
    for (let index = 0; index < accepted.length; index += 1) {
      const file = accepted[index];
      const downloadUrl = trimValue(
        file.url_private_download || file.url_private,
      );
      if (!downloadUrl || !isAllowedSlackFileUrl(downloadUrl)) {
        continue;
      }

      const filename = sanitizeFilename(
        trimValue(file.name) || `slack-attachment-${index + 1}`,
      );
      const response = await fetch(downloadUrl, {
        headers: {
          authorization: `Bearer ${botToken}`,
        },
      });
      if (!response.ok) {
        logger.warn(
          {
            status: response.status,
            url: downloadUrl,
            filename,
          },
          'Failed to download Slack attachment',
        );
        continue;
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        continue;
      }

      tempDir ??= await fs.mkdtemp(
        path.join(os.tmpdir(), SLACK_MEDIA_TMP_PREFIX),
      );
      const filePath = path.join(tempDir, filename);
      await fs.writeFile(filePath, bytes);
      media.push({
        path: filePath,
        url: downloadUrl,
        originalUrl: downloadUrl,
        mimeType: trimValue(file.mimetype) || null,
        sizeBytes: bytes.length,
        filename,
      });
    }
  } catch (error) {
    if (tempDir) {
      await fs
        .rm(tempDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
    throw error;
  }

  if (tempDir && media.length === 0) {
    await fs
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }

  return media;
}

async function removeSlackManagedDirectory(directory: string): Promise<void> {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) {
    logger.debug(
      { error, directory },
      'Failed to remove Slack inbound media directory',
    );
  }
}

export function resolveSlackManagedMediaDirectory(
  filePath: string | null | undefined,
): string | null {
  return resolveManagedTempMediaDir({
    filePath: String(filePath || ''),
    prefixes: [SLACK_MEDIA_TMP_PREFIX],
  });
}

export async function cleanupSlackInboundMedia(
  media: MediaContextItem[],
): Promise<void> {
  const directories = new Set<string>();
  for (const item of media) {
    const directory = resolveSlackManagedMediaDirectory(item.path);
    if (directory) {
      directories.add(directory);
    }
  }

  for (const directory of directories) {
    await removeSlackManagedDirectory(directory);
  }
}

export function cleanSlackIncomingText(
  text: string | null | undefined,
  botUserId: string | null,
): string {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const withoutBotMention = botUserId
    ? raw.replace(new RegExp(`<@${botUserId}>`, 'gi'), ' ')
    : raw;
  return withoutBotMention.replace(/[ \t]{2,}/g, ' ').trim();
}

export function hasSlackBotMention(
  text: string | null | undefined,
  botUserId: string | null,
): boolean {
  const normalizedText = String(text || '').trim();
  const normalizedBotUserId = String(botUserId || '').trim();
  if (!normalizedText || !normalizedBotUserId) return false;
  return normalizedText.includes(`<@${normalizedBotUserId}>`);
}

export function isSlackDmEvent(event: SlackMessageEvent): boolean {
  const channelType = String(event.channel_type || '')
    .trim()
    .toLowerCase();
  if (channelType === 'im') return true;
  return /^D[A-Z0-9]{8,}$/i.test(String(event.channel || '').trim());
}

export function evaluateSlackAccessPolicy(params: {
  dmPolicy: SlackDmPolicy;
  groupPolicy: SlackGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  userId: string;
  isDm: boolean;
}): SlackAccessDecision {
  if (params.isDm) {
    if (params.dmPolicy === 'disabled') {
      return { allowed: false, isDm: true };
    }
    if (params.dmPolicy === 'open') {
      return { allowed: true, isDm: true };
    }
    return {
      allowed: matchesAllowList(params.allowFrom, params.userId),
      isDm: true,
    };
  }

  if (params.groupPolicy === 'disabled') {
    return { allowed: false, isDm: false };
  }
  if (params.groupPolicy === 'open') {
    return { allowed: true, isDm: false };
  }
  return {
    allowed: matchesAllowList(params.groupAllowFrom, params.userId),
    isDm: false,
  };
}

export function buildSlackInboundRouting(params: {
  event: SlackMessageEvent;
  botUserId: string | null;
  config: RuntimeSlackConfig;
  activeThreadKeys: ReadonlySet<string>;
  agentId?: string;
}): SlackInboundRouting | null {
  const userId = normalizeSlackUserId(params.event.user);
  const channelId = parseSlackChannelTarget(params.event.channel)?.channelId;
  const messageTs = normalizeSlackThreadTs(params.event.ts);
  if (!userId || !channelId || !messageTs) {
    return null;
  }

  const teamId = String(params.event.team || '').trim() || null;
  const isDm = isSlackDmEvent(params.event);
  const access = evaluateSlackAccessPolicy({
    dmPolicy: params.config.dmPolicy,
    groupPolicy: params.config.groupPolicy,
    allowFrom: params.config.allowFrom,
    groupAllowFrom: params.config.groupAllowFrom,
    userId,
    isDm,
  });
  if (!access.allowed) {
    return null;
  }

  const incomingThreadTs = normalizeSlackThreadTs(params.event.thread_ts);
  const threadKey = incomingThreadTs
    ? `${channelId}:${incomingThreadTs}`
    : `${channelId}:${messageTs}`;
  const hasMention = hasSlackBotMention(params.event.text, params.botUserId);
  const allowWithoutMention =
    !isDm &&
    incomingThreadTs !== null &&
    params.activeThreadKeys.has(threadKey);
  if (
    !isDm &&
    params.config.requireMention &&
    !hasMention &&
    !allowWithoutMention
  ) {
    return null;
  }

  const replyStyle: SlackReplyStyle = isDm
    ? 'top-level'
    : params.config.replyStyle;
  const replyThreadTs =
    !isDm && replyStyle === 'thread' ? incomingThreadTs || messageTs : null;
  const target = buildSlackChannelTarget(channelId, replyThreadTs);
  const sessionId = buildSessionKey(
    params.agentId || DEFAULT_AGENT_ID,
    'slack',
    isDm ? 'dm' : replyThreadTs ? 'thread' : 'channel',
    isDm ? userId : channelId,
    {
      ...(replyThreadTs ? { threadId: replyThreadTs } : {}),
      ...(teamId ? { topicId: teamId } : {}),
    },
  );

  return {
    sessionId,
    channelId: target,
    guildId: teamId,
    userId,
    target,
    isDm,
    threadTs: replyThreadTs,
    replyStyle,
  };
}

export async function processInboundSlackEvent(params: {
  event: SlackMessageEvent;
  botUserId: string | null;
  config: RuntimeSlackConfig;
  activeThreadKeys: ReadonlySet<string>;
  botToken: string;
  agentId?: string;
}): Promise<ProcessedSlackInbound | null> {
  const subtype = trimValue(params.event.subtype);
  if (trimValue(params.event.bot_id)) return null;
  if (subtype && subtype !== 'file_share') {
    return null;
  }

  const routing = buildSlackInboundRouting({
    event: params.event,
    botUserId: params.botUserId,
    config: params.config,
    activeThreadKeys: params.activeThreadKeys,
    agentId: params.agentId,
  });
  if (!routing) return null;

  const content = cleanSlackIncomingText(params.event.text, params.botUserId);
  const files = Array.isArray(params.event.files)
    ? params.event.files.filter(
        (entry): entry is SlackFileEvent =>
          entry != null && typeof entry === 'object',
      )
    : [];
  const media = await downloadSlackInboundMedia({
    files,
    botToken: params.botToken,
    mediaMaxMb: params.config.mediaMaxMb,
  });
  if (!content && media.length === 0) {
    return null;
  }

  return {
    ...routing,
    content,
    media,
  };
}
