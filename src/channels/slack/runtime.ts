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
import {
  type ApprovalPresentation,
  getApprovalPromptText,
  getApprovalVisibleText,
} from '../../gateway/approval-presentation.js';
import type { GatewayChatApprovalEvent } from '../../gateway/gateway-types.js';
import { claimPendingApprovalByApprovalId } from '../../gateway/pending-approvals.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { SLACK_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  buildSlackApprovalBlocks,
  buildSlackResolvedApprovalBlocks,
  parseSlackApprovalAction,
} from './approval-buttons.js';
import { formatSlackMrkdwn, prepareSlackTextChunks } from './delivery.js';
import {
  cleanupSlackInboundMedia,
  processInboundSlackEvent,
  type SlackMessageEvent,
} from './inbound.js';
import { buildSlackChannelTarget, parseSlackChannelTarget } from './target.js';

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
  sendApprovalNotification?: (params: {
    approval: Pick<
      GatewayChatApprovalEvent,
      'approvalId' | 'prompt' | 'summary'
    >;
    presentation: ApprovalPresentation;
    userId: string;
  }) => Promise<{ disableButtons: () => Promise<void> } | null>;
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

export type SlackCommandReplyFn = (content: string) => Promise<void>;

export type SlackCommandHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  args: string[],
  reply: SlackCommandReplyFn,
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

function extractSlackThreadTs(value: unknown): string | null {
  return typeof value === 'string' ? trimValue(value) || null : null;
}

function extractSlackActionTarget(body: {
  channel?: { id?: string };
  container?: { thread_ts?: string };
  message?: { thread_ts?: string };
}): string | null {
  const channelId =
    body.channel && typeof body.channel === 'object'
      ? trimValue(body.channel.id)
      : '';
  if (!channelId) return null;
  const threadTs =
    extractSlackThreadTs(body.message?.thread_ts) ||
    extractSlackThreadTs(body.container?.thread_ts);
  try {
    return buildSlackChannelTarget(channelId, threadTs);
  } catch {
    return null;
  }
}

function buildSlackApprovalPromptText(userId: string, text: string): string {
  const mention = trimValue(userId) ? `<@${trimValue(userId)}>` : '';
  const normalizedText = trimValue(text);
  return [mention, normalizedText].filter(Boolean).join(' ').trim();
}

function buildSlackApprovalDecisionText(
  action: string,
  username: string,
): string {
  const actor = trimValue(username) || 'unknown user';
  if (action === 'yes') {
    return `*Approved once by ${actor}.*`;
  }
  if (action === 'session') {
    return `*Approved for session by ${actor}.*`;
  }
  if (action === 'agent') {
    return `*Approved for agent by ${actor}.*`;
  }
  if (action === 'all') {
    return `*Approved for all by ${actor}.*`;
  }
  return `*Denied by ${actor}.*`;
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
      mrkdwn: true,
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
  const caption = formatSlackMrkdwn(trimValue(params.caption));
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

async function updateSlackApprovalMessage(params: {
  channelId: string;
  messageTs: string;
  promptText: string;
  statusText: string;
}): Promise<void> {
  if (!app) {
    throw new Error('Slack runtime is not initialized.');
  }

  await app.client.chat.update({
    channel: params.channelId,
    ts: params.messageTs,
    text: params.statusText,
    blocks: buildSlackResolvedApprovalBlocks(
      params.promptText,
      params.statusText,
    ),
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
        sendApprovalNotification: async ({
          approval,
          presentation,
          userId,
        }) => {
          if (!app) {
            return null;
          }
          const approvalChannelId =
            parseSlackChannelTarget(inbound.target)?.channelId || '';
          if (!approvalChannelId) {
            throw new Error(`Invalid Slack approval target: ${inbound.target}`);
          }
          const visibleText = getApprovalVisibleText(approval, presentation);
          const promptText =
            buildSlackApprovalPromptText(userId, visibleText) ||
            'Approval required.';
          const fallbackText =
            buildSlackApprovalPromptText(
              userId,
              visibleText || getApprovalPromptText(approval),
            ) || 'Approval required.';
          const response = await app.client.chat.postMessage({
            channel: approvalChannelId,
            text: fallbackText,
            blocks: buildSlackApprovalBlocks(promptText, approval.approvalId, {
              showButtons: presentation.showButtons,
            }),
            mrkdwn: true,
            ...(inbound.threadTs ? { thread_ts: inbound.threadTs } : {}),
          });
          const messageTs = trimValue(
            typeof response.ts === 'string' ? response.ts : undefined,
          );
          if (!messageTs) {
            return null;
          }
          if (!presentation.showButtons) {
            return null;
          }
          return {
            disableButtons: async () => {
              await updateSlackApprovalMessage({
                channelId: approvalChannelId,
                messageTs,
                promptText,
                statusText: '_Approval request is no longer active._',
              });
            },
          };
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
  commandHandler: SlackCommandHandler,
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
  app.action(/^approve:(yes|session|agent|all|no)$/, async (payload) => {
    await payload.ack();
    const action =
      payload.action && typeof payload.action === 'object'
        ? payload.action
        : {};
    const parsed = parseSlackApprovalAction(
      trimValue(
        'action_id' in action && typeof action.action_id === 'string'
          ? action.action_id
          : '',
      ),
      trimValue(
        'value' in action && typeof action.value === 'string'
          ? action.value
          : '',
      ),
    );
    if (!parsed) {
      return;
    }

    const body =
      payload.body && typeof payload.body === 'object' ? payload.body : {};
    const user =
      'user' in body && body.user && typeof body.user === 'object'
        ? body.user
        : {};
    const channel =
      'channel' in body && body.channel && typeof body.channel === 'object'
        ? body.channel
        : {};
    const message =
      'message' in body && body.message && typeof body.message === 'object'
        ? body.message
        : {};
    const userId = trimValue('id' in user ? String(user.id || '') : '');
    const channelId = trimValue(
      'id' in channel ? String(channel.id || '') : '',
    );

    const pending = claimPendingApprovalByApprovalId({
      approvalId: parsed.approvalId,
      userId,
    });
    if (pending.status === 'not_found') {
      if (channelId && userId) {
        await app?.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'This approval has expired or was already handled.',
        });
      }
      return;
    }
    if (pending.status === 'unauthorized') {
      if (channelId && userId) {
        await app?.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'Only the requesting user can respond.',
        });
      }
      return;
    }
    if (pending.status === 'already_handled') {
      if (channelId && userId) {
        await app?.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: 'This approval has already been handled.',
        });
      }
      return;
    }

    const approvalTarget = extractSlackActionTarget(
      body as {
        channel?: { id?: string };
        container?: { thread_ts?: string };
        message?: { thread_ts?: string };
      },
    );
    const promptText =
      trimValue(
        'text' in message && typeof message.text === 'string'
          ? message.text
          : '',
      ) || 'Approval required.';

    try {
      const username = await resolveSlackDisplayName(userId);
      await commandHandler(
        pending.sessionId,
        null,
        approvalTarget || buildSlackChannelTarget(channelId),
        userId,
        username,
        ['approve', parsed.action, parsed.approvalId],
        async (content) => {
          if (!approvalTarget) {
            throw new Error('Slack approval action is missing a reply target.');
          }
          await postSlackText(approvalTarget, content);
        },
      );
      const messageTs = trimValue(
        'ts' in message ? String(message.ts || '') : '',
      );
      if (channelId && messageTs) {
        await updateSlackApprovalMessage({
          channelId,
          messageTs,
          promptText,
          statusText: buildSlackApprovalDecisionText(parsed.action, username),
        });
      }
    } catch (error) {
      pending.entry.resolvedAt = null;
      logger.error(
        { error, channelId, userId, approvalId: parsed.approvalId },
        'Slack approval button failed',
      );
      if (approvalTarget) {
        await postSlackText(
          approvalTarget,
          formatSlackMrkdwn(
            `**Gateway Error:** ${error instanceof Error ? error.message : String(error)}`,
          ),
        ).catch(() => {});
      }
    }
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
