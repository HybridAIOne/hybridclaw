import { createReadStream } from 'node:fs';
import path from 'node:path';
import { App, LogLevel } from '@slack/bolt';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import {
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_ENABLED,
} from '../../config/config.js';
import { getRuntimeConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { SLACK_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import { prepareSlackTextChunks } from './delivery.js';
import {
  cleanupSlackInboundMedia,
  processInboundSlackEvent,
  type SlackMessageEvent,
} from './inbound.js';
import { parseSlackChannelTarget } from './target.js';

const SLACK_NOOP_ABORT_SIGNAL = new AbortController().signal;
const MAX_SEEN_EVENTS = 2_000;

export type SlackReplyFn = (content: string) => Promise<void>;

export interface SlackMessageContext {
  abortSignal: AbortSignal;
  inbound: {
    target: string;
    isDm: boolean;
    threadTs: string | null;
    rawEvent: SlackMessageEvent;
  };
}

export type SlackMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: SlackReplyFn,
  context: SlackMessageContext,
) => Promise<void>;

export interface SlackActiveSessionSendParams {
  sessionId: string;
  text?: string;
  filePath?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string | null;
}

interface ActiveSlackSession {
  target: string;
  channelId: string;
  isDm: boolean;
  threadTs: string | null;
}

let app: App | null = null;
let runtimeInitialized = false;
let botUserId = '';
const activeSlackSessions = new Map<string, ActiveSlackSession>();
const activeThreadKeys = new Set<string>();
const seenEventKeys = new Map<string, number>();
const userDisplayNameCache = new Map<string, string>();

function trimValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function rememberSeenEvent(key: string): boolean {
  if (!key) return false;
  if (seenEventKeys.has(key)) {
    seenEventKeys.delete(key);
    seenEventKeys.set(key, Date.now());
    return true;
  }
  seenEventKeys.set(key, Date.now());
  if (seenEventKeys.size > MAX_SEEN_EVENTS) {
    const oldest = seenEventKeys.keys().next().value;
    if (typeof oldest === 'string') {
      seenEventKeys.delete(oldest);
    }
  }
  return false;
}

function rememberActiveSlackSession(
  sessionId: string,
  session: ActiveSlackSession,
): void {
  activeSlackSessions.set(sessionId, session);
  if (session.threadTs) {
    activeThreadKeys.add(`${session.channelId}:${session.threadTs}`);
  }
}

async function resolveSlackDisplayName(userId: string): Promise<string> {
  const normalizedUserId = trimValue(userId).toUpperCase();
  if (!normalizedUserId) return 'unknown';
  const cached = userDisplayNameCache.get(normalizedUserId);
  if (cached) return cached;
  if (!app) return normalizedUserId;

  try {
    const response = await app.client.users.info({ user: normalizedUserId });
    const user =
      response.user && typeof response.user === 'object'
        ? (response.user as {
            real_name?: string;
            name?: string;
            profile?: { display_name?: string; real_name?: string };
          })
        : null;
    const profile =
      user?.profile && typeof user.profile === 'object' ? user.profile : null;
    const displayName =
      trimValue(profile?.display_name) ||
      trimValue(profile?.real_name) ||
      trimValue(user?.real_name) ||
      trimValue(user?.name) ||
      normalizedUserId;
    userDisplayNameCache.set(normalizedUserId, displayName);
    return displayName;
  } catch (error) {
    logger.debug(
      { error, userId: normalizedUserId },
      'Slack user lookup failed',
    );
    return normalizedUserId;
  }
}

async function postSlackText(target: string, text: string): Promise<void> {
  const parsedTarget = parseSlackChannelTarget(target);
  if (!parsedTarget) {
    throw new Error(`Invalid Slack target: ${target}`);
  }
  if (!app) {
    throw new Error('Slack runtime is not initialized.');
  }

  for (const chunk of prepareSlackTextChunks(text)) {
    await app.client.chat.postMessage({
      channel: parsedTarget.channelId,
      text: chunk,
      ...(parsedTarget.threadTs ? { thread_ts: parsedTarget.threadTs } : {}),
    });
  }
}

async function postSlackFile(params: {
  target: string;
  filePath: string;
  filename?: string | null;
  caption?: string | null;
}): Promise<void> {
  const parsedTarget = parseSlackChannelTarget(params.target);
  if (!parsedTarget) {
    throw new Error(`Invalid Slack target: ${params.target}`);
  }
  if (!app) {
    throw new Error('Slack runtime is not initialized.');
  }

  const filename =
    trimValue(params.filename) || path.basename(path.resolve(params.filePath));
  const caption = trimValue(params.caption);
  if (parsedTarget.threadTs && caption) {
    await app.client.files.uploadV2({
      channel_id: parsedTarget.channelId,
      file: createReadStream(params.filePath),
      filename,
      initial_comment: caption,
      thread_ts: parsedTarget.threadTs,
    });
    return;
  }
  if (parsedTarget.threadTs) {
    await app.client.files.uploadV2({
      channel_id: parsedTarget.channelId,
      file: createReadStream(params.filePath),
      filename,
      thread_ts: parsedTarget.threadTs,
    });
    return;
  }
  if (caption) {
    await app.client.files.uploadV2({
      channel_id: parsedTarget.channelId,
      file: createReadStream(params.filePath),
      filename,
      initial_comment: caption,
    });
    return;
  }
  await app.client.files.uploadV2({
    channel_id: parsedTarget.channelId,
    file: createReadStream(params.filePath),
    filename,
  });
}

async function handleIncomingSlackEvent(
  rawEvent: unknown,
  messageHandler: SlackMessageHandler,
): Promise<void> {
  if (!rawEvent || typeof rawEvent !== 'object') return;
  const event = rawEvent as SlackMessageEvent;

  const eventKey = `${trimValue(event.channel)}:${trimValue(event.ts)}`;
  if (rememberSeenEvent(eventKey)) {
    return;
  }

  const inbound = await processInboundSlackEvent({
    event,
    botUserId: botUserId || null,
    config: getRuntimeConfig().slack,
    activeThreadKeys,
    botToken: trimValue(SLACK_BOT_TOKEN),
    agentId: DEFAULT_AGENT_ID,
  });
  if (!inbound) return;

  try {
    rememberActiveSlackSession(inbound.sessionId, {
      target: inbound.target,
      channelId:
        parseSlackChannelTarget(inbound.target)?.channelId || inbound.target,
      isDm: inbound.isDm,
      threadTs: inbound.threadTs,
    });
    const username = await resolveSlackDisplayName(inbound.userId);
    const reply: SlackReplyFn = async (content) => {
      await postSlackText(inbound.target, content);
    };
    await messageHandler(
      inbound.sessionId,
      inbound.guildId,
      inbound.channelId,
      inbound.userId,
      username,
      inbound.content,
      inbound.media,
      reply,
      {
        abortSignal: SLACK_NOOP_ABORT_SIGNAL,
        inbound: {
          target: inbound.target,
          isDm: inbound.isDm,
          threadTs: inbound.threadTs,
          rawEvent: event,
        },
      },
    );
  } finally {
    await cleanupSlackInboundMedia(inbound.media).catch((error) => {
      logger.debug(
        { error, sessionId: inbound.sessionId, channelId: inbound.channelId },
        'Failed to clean up Slack inbound media',
      );
    });
  }
}

export async function initSlack(
  messageHandler: SlackMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;
  runtimeInitialized = true;
  registerChannel({
    kind: 'slack',
    id: 'slack',
    capabilities: SLACK_CAPABILITIES,
  });

  if (!SLACK_ENABLED) {
    throw new Error('Slack runtime is disabled.');
  }

  const botToken = trimValue(SLACK_BOT_TOKEN);
  const appToken = trimValue(SLACK_APP_TOKEN);
  if (!botToken || !appToken) {
    throw new Error('Slack bot/app token is missing.');
  }

  app = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  const auth = await app.client.auth.test();
  botUserId = trimValue(
    typeof auth.user_id === 'string' ? auth.user_id : undefined,
  );
  if (!botUserId) {
    throw new Error('Slack auth.test did not return a bot user id.');
  }

  app.event('message', async ({ event }) => {
    await handleIncomingSlackEvent(event as unknown, messageHandler);
  });
  app.event('app_mention', async ({ event }) => {
    await handleIncomingSlackEvent(event as unknown, messageHandler);
  });

  await app.start();
}

export async function sendToSlackTarget(
  target: string,
  text: string,
): Promise<void> {
  await postSlackText(target, text);
}

export async function sendSlackFileToTarget(params: {
  target: string;
  filePath: string;
  filename?: string | null;
  caption?: string | null;
}): Promise<void> {
  await postSlackFile(params);
}

export function hasActiveSlackSession(sessionId: string): boolean {
  return activeSlackSessions.has(trimValue(sessionId));
}

export async function sendToActiveSlackSession(
  params: SlackActiveSessionSendParams,
): Promise<{
  channelId: string;
  attachmentCount: number;
}> {
  const session = activeSlackSessions.get(trimValue(params.sessionId));
  if (!session) {
    throw new Error('Slack session is not active.');
  }

  const text = trimValue(params.text);
  if (text) {
    await postSlackText(session.target, text);
  }
  if (trimValue(params.filePath)) {
    await postSlackFile({
      target: session.target,
      filePath: trimValue(params.filePath),
      filename: params.filename,
      caption: params.caption,
    });
  }

  return {
    channelId: session.target,
    attachmentCount: trimValue(params.filePath) ? 1 : 0,
  };
}

export async function shutdownSlack(): Promise<void> {
  activeSlackSessions.clear();
  activeThreadKeys.clear();
  seenEventKeys.clear();
  userDisplayNameCache.clear();
  botUserId = '';
  const activeApp = app;
  app = null;
  runtimeInitialized = false;
  await activeApp?.stop();
}
