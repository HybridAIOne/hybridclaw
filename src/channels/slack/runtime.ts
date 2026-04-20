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
import {
  claimPendingApprovalByApprovalId,
  rollbackPendingApprovalClaim,
} from '../../gateway/pending-approvals.js';
import { logger } from '../../logger.js';
import { buildSessionKey } from '../../session/session-key.js';
import type { MediaContextItem } from '../../types/container.js';
import { normalizeTrimmedString as trimValue } from '../../utils/normalized-strings.js';
import { SLACK_CAPABILITIES } from '../channel.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import {
  buildSlackApprovalBlocks,
  buildSlackResolvedApprovalBlocks,
  parseSlackApprovalAction,
} from './approval-buttons.js';
import { formatSlackMrkdwn, prepareSlackTextChunks } from './delivery.js';
import {
  cleanupSlackInboundMedia,
  evaluateSlackAccessPolicy,
  processInboundSlackEvent,
  type SlackMessageEvent,
} from './inbound.js';
import {
  getSlackNativeSlashCommandNames,
  resolveSlackNativeSlashCommandArgs,
} from './slash-commands.js';
import {
  buildSlackChannelTarget,
  normalizeSlackChannelId,
  normalizeSlackUserId,
  parseSlackChannelTarget,
} from './target.js';

const MAX_SEEN_EVENTS = 2_000;
const MAX_ACTIVE_SLACK_SESSIONS = 2_000;
const MAX_USER_DISPLAY_NAMES = 2_000;
const SLACK_STATUS_INDICATOR_DELAY_MS = 750;

export type SlackReplyFn = (content: string) => Promise<void>;

export interface SlackMessageContext {
  emitLifecyclePhase?: (phase: SlackLifecyclePhase) => void;
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

type SlackUploadFileArgs = Parameters<App['client']['files']['uploadV2']>[0];
type SlackApprovalRequest = Pick<
  GatewayChatApprovalEvent,
  'approvalId' | 'prompt' | 'summary'
>;

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

interface SlackNativeCommandRouting {
  sessionId: string;
  guildId: string | null;
  target: string;
  channelId: string;
  userId: string;
  isDm: boolean;
}

interface SlackSlashCommandPayload {
  command?: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  team_id?: string;
}

type SlackLifecyclePhase =
  | 'queued'
  | 'thinking'
  | 'toolUse'
  | 'streaming'
  | 'done'
  | 'error';

interface SlackStatusController {
  setPhase: (phase: SlackLifecyclePhase) => void;
  stop: () => Promise<void>;
}

let app: App | null = null;
let botUserId = '';
const activeSlackSessions = new Map<string, ActiveSlackSession>();
const activeThreadKeys = new Set<string>();
const seenEventKeys = new Map<string, number>();
const userDisplayNameCache = new Map<string, string>();

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

function rememberSlackDisplayName(userId: string, displayName: string): void {
  if (!userId) return;
  if (userDisplayNameCache.has(userId)) {
    userDisplayNameCache.delete(userId);
  }
  userDisplayNameCache.set(userId, displayName);
  if (userDisplayNameCache.size > MAX_USER_DISPLAY_NAMES) {
    const oldest = userDisplayNameCache.keys().next().value;
    if (typeof oldest === 'string') {
      userDisplayNameCache.delete(oldest);
    }
  }
}

function buildActiveSlackThreadKey(
  session: ActiveSlackSession | null | undefined,
): string | null {
  if (!session?.threadTs) {
    return null;
  }
  return `${session.channelId}:${session.threadTs}`;
}

function removeActiveThreadKeyIfUnused(threadKey: string): void {
  for (const session of activeSlackSessions.values()) {
    if (buildActiveSlackThreadKey(session) === threadKey) {
      return;
    }
  }
  activeThreadKeys.delete(threadKey);
}

function touchActiveSlackThreadKey(threadKey: string): void {
  activeThreadKeys.delete(threadKey);
  activeThreadKeys.add(threadKey);
}

function evictActiveSlackSession(sessionId: string): void {
  const existing = activeSlackSessions.get(sessionId);
  if (!existing) {
    return;
  }
  activeSlackSessions.delete(sessionId);
  const threadKey = buildActiveSlackThreadKey(existing);
  if (threadKey) {
    removeActiveThreadKeyIfUnused(threadKey);
  }
}

function enforceActiveSlackSessionLimit(): void {
  while (activeSlackSessions.size > MAX_ACTIVE_SLACK_SESSIONS) {
    const oldest = activeSlackSessions.keys().next().value;
    if (typeof oldest !== 'string') {
      return;
    }
    evictActiveSlackSession(oldest);
  }
}

function rememberActiveSlackSession(
  sessionId: string,
  session: ActiveSlackSession,
): void {
  const normalizedSessionId = trimValue(sessionId);
  if (!normalizedSessionId) {
    return;
  }

  const existing = activeSlackSessions.get(normalizedSessionId);
  const existingThreadKey = buildActiveSlackThreadKey(existing);
  const nextThreadKey = buildActiveSlackThreadKey(session);
  if (existing) {
    activeSlackSessions.delete(normalizedSessionId);
    if (existingThreadKey && existingThreadKey !== nextThreadKey) {
      removeActiveThreadKeyIfUnused(existingThreadKey);
    }
  }

  activeSlackSessions.set(normalizedSessionId, session);
  if (nextThreadKey) {
    touchActiveSlackThreadKey(nextThreadKey);
  }
  enforceActiveSlackSessionLimit();
}

function touchActiveSlackSession(sessionId: string): ActiveSlackSession | null {
  const normalizedSessionId = trimValue(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const session = activeSlackSessions.get(normalizedSessionId);
  if (!session) {
    return null;
  }

  activeSlackSessions.delete(normalizedSessionId);
  activeSlackSessions.set(normalizedSessionId, session);
  const threadKey = buildActiveSlackThreadKey(session);
  if (threadKey) {
    touchActiveSlackThreadKey(threadKey);
  }
  return session;
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

const SLACK_APPROVAL_DECISION_TEXT: Record<string, string> = {
  yes: 'Approved once',
  session: 'Approved for session',
  agent: 'Approved for agent',
  all: 'Approved for all',
  no: 'Denied',
};

function buildSlackApprovalDecisionText(
  action: string,
  username: string,
): string {
  const actor = trimValue(username) || 'unknown user';
  const decisionText = SLACK_APPROVAL_DECISION_TEXT[action] || 'Denied';
  return `*${decisionText} by ${actor}.*`;
}

function buildSlackStatusText(phase: SlackLifecyclePhase): string | null {
  if (phase === 'done' || phase === 'error') {
    return null;
  }
  if (phase === 'streaming') {
    return '_Writing..._';
  }
  if (phase === 'toolUse') {
    return '_Using tools..._';
  }
  return '_Thinking..._';
}

function isSlackDmChannelId(channelId: string): boolean {
  return /^D[A-Z0-9]{8,}$/i.test(channelId);
}

function buildSlackNativeCommandRouting(
  payload: SlackSlashCommandPayload,
): SlackNativeCommandRouting | null {
  const channelId = normalizeSlackChannelId(payload.channel_id);
  const userId = normalizeSlackUserId(payload.user_id);
  if (!channelId || !userId) {
    return null;
  }

  const isDm = isSlackDmChannelId(channelId);
  const isAllowed = evaluateSlackAccessPolicy({
    dmPolicy: getRuntimeConfig().slack.dmPolicy,
    groupPolicy: getRuntimeConfig().slack.groupPolicy,
    allowFrom: getRuntimeConfig().slack.allowFrom,
    groupAllowFrom: getRuntimeConfig().slack.groupAllowFrom,
    userId,
    isDm,
  });
  if (!isAllowed) {
    return null;
  }

  const guildId = trimValue(payload.team_id) || null;
  return {
    sessionId: buildSessionKey(
      DEFAULT_AGENT_ID,
      'slack',
      isDm ? 'dm' : 'channel',
      isDm ? userId : channelId,
      {
        ...(guildId ? { topicId: guildId } : {}),
      },
    ),
    guildId,
    target: buildSlackChannelTarget(channelId),
    channelId,
    userId,
    isDm,
  };
}

async function respondToSlackSlashCommand(
  respond:
    | ((message: { text: string; response_type: 'ephemeral' }) => Promise<void>)
    | undefined,
  target: string | null,
  text: string,
): Promise<void> {
  if (!respond) {
    if (!target) {
      throw new Error('Slack slash command reply target is missing.');
    }
    await postSlackText(target, text);
    return;
  }

  for (const chunk of prepareSlackTextChunks(text)) {
    await respond({
      text: chunk,
      response_type: 'ephemeral',
    });
  }
}

function createSlackStatusController(target: string): SlackStatusController {
  const parsedTarget = parseSlackChannelTarget(target);
  if (!app || !parsedTarget) {
    return {
      setPhase: () => {},
      stop: async () => {},
    };
  }

  let stopped = false;
  let desiredText: string | null = null;
  let postedText = '';
  let messageTs = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingUpdate = Promise.resolve();

  const queue = (work: () => Promise<void>): void => {
    pendingUpdate = pendingUpdate.then(work).catch((error) => {
      logger.debug(
        {
          error,
          target: parsedTarget.target,
          channelId: parsedTarget.channelId,
          threadTs: parsedTarget.threadTs,
        },
        'Slack status indicator update failed',
      );
    });
  };

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const ensureStatusMessage = (): void => {
    if (stopped || !desiredText || messageTs) {
      return;
    }
    queue(async () => {
      if (stopped || !desiredText || messageTs || !app) {
        return;
      }
      const response = await app.client.chat.postMessage({
        channel: parsedTarget.channelId,
        text: desiredText,
        mrkdwn: true,
        ...(parsedTarget.threadTs ? { thread_ts: parsedTarget.threadTs } : {}),
      });
      messageTs = trimValue(
        typeof response.ts === 'string' ? response.ts : undefined,
      );
      postedText = desiredText;
    });
  };

  return {
    setPhase: (phase) => {
      if (stopped) {
        return;
      }
      const nextText = buildSlackStatusText(phase);
      if (!nextText) {
        void pendingUpdate.then(() => undefined);
        return;
      }
      desiredText = nextText;
      if (!messageTs) {
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            ensureStatusMessage();
          }, SLACK_STATUS_INDICATOR_DELAY_MS);
        }
        return;
      }
      if (postedText === desiredText) {
        return;
      }
      queue(async () => {
        if (stopped || !app || !messageTs || !desiredText) {
          return;
        }
        await app.client.chat.update({
          channel: parsedTarget.channelId,
          ts: messageTs,
          text: desiredText,
        });
        postedText = desiredText;
      });
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearTimer();
      await pendingUpdate.catch(() => undefined);
      if (!messageTs || !app) {
        return;
      }
      const ts = messageTs;
      messageTs = '';
      await app.client.chat
        .delete({
          channel: parsedTarget.channelId,
          ts,
        })
        .catch((error) => {
          logger.debug(
            { error, target: parsedTarget.target, ts },
            'Slack status indicator cleanup failed',
          );
        });
    },
  };
}

async function resolveSlackDisplayName(userId: string): Promise<string> {
  const normalizedUserId = trimValue(userId).toUpperCase();
  if (!normalizedUserId) return 'unknown';
  const cached = userDisplayNameCache.get(normalizedUserId);
  if (cached) {
    rememberSlackDisplayName(normalizedUserId, cached);
    return cached;
  }
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
    rememberSlackDisplayName(normalizedUserId, displayName);
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

  const uploadParams = {
    channel_id: parsedTarget.channelId,
    file: createReadStream(params.filePath),
    filename,
    ...(caption ? { initial_comment: caption } : {}),
    ...(parsedTarget.threadTs ? { thread_ts: parsedTarget.threadTs } : {}),
  };

  await app.client.files.uploadV2(uploadParams as SlackUploadFileArgs);
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

export async function sendSlackApprovalNotification(params: {
  target: string;
  approval: SlackApprovalRequest;
  presentation: ApprovalPresentation;
  userId: string;
}): Promise<{ disableButtons: () => Promise<void> } | null> {
  if (!app) {
    return null;
  }

  const parsedTarget = parseSlackChannelTarget(params.target);
  if (!parsedTarget) {
    throw new Error(`Invalid Slack approval target: ${params.target}`);
  }

  const visibleText = getApprovalVisibleText(
    params.approval,
    params.presentation,
  );
  const promptText =
    buildSlackApprovalPromptText(params.userId, visibleText) ||
    'Approval required.';
  const fallbackText =
    buildSlackApprovalPromptText(
      params.userId,
      visibleText || getApprovalPromptText(params.approval),
    ) || 'Approval required.';
  const response = await app.client.chat.postMessage({
    channel: parsedTarget.channelId,
    text: fallbackText,
    blocks: buildSlackApprovalBlocks(promptText, params.approval.approvalId, {
      showButtons: params.presentation.showButtons,
    }),
    mrkdwn: true,
    ...(parsedTarget.threadTs ? { thread_ts: parsedTarget.threadTs } : {}),
  });
  const messageTs = trimValue(
    typeof response.ts === 'string' ? response.ts : undefined,
  );
  if (!messageTs || !params.presentation.showButtons) {
    return null;
  }

  return {
    disableButtons: async () => {
      await updateSlackApprovalMessage({
        channelId: parsedTarget.channelId,
        messageTs,
        promptText,
        statusText: '_Approval request is no longer active._',
      });
    },
  };
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

  const statusController = createSlackStatusController(inbound.target);
  statusController.setPhase('thinking');
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
      await statusController.stop();
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
        emitLifecyclePhase: (phase) => {
          statusController.setPhase(phase);
        },
        inbound: {
          target: inbound.target,
          isDm: inbound.isDm,
          threadTs: inbound.threadTs,
          rawEvent: event,
        },
        sendApprovalNotification: ({ approval, presentation, userId }) =>
          statusController.stop().then(() =>
            sendSlackApprovalNotification({
              target: inbound.target,
              approval,
              presentation,
              userId,
            }),
          ),
      },
    );
  } finally {
    await statusController.stop().catch((error) => {
      logger.debug(
        { error, sessionId: inbound.sessionId, channelId: inbound.channelId },
        'Failed to stop Slack status indicator',
      );
    });
    await cleanupSlackInboundMedia(inbound.media).catch((error) => {
      logger.debug(
        { error, sessionId: inbound.sessionId, channelId: inbound.channelId },
        'Failed to clean up Slack inbound media',
      );
    });
  }
}

async function startSlackRuntime(handler: {
  commandHandler: SlackCommandHandler;
  messageHandler: SlackMessageHandler;
}): Promise<void> {
  if (!SLACK_ENABLED) {
    throw new Error('Slack runtime is disabled.');
  }

  const botToken = trimValue(SLACK_BOT_TOKEN);
  const appToken = trimValue(SLACK_APP_TOKEN);
  if (!botToken || !appToken) {
    throw new Error('Slack bot/app token is missing.');
  }

  const nextApp = new App({
    token: botToken,
    appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });
  app = nextApp;
  try {
    const auth = await nextApp.client.auth.test();
    botUserId = trimValue(
      typeof auth.user_id === 'string' ? auth.user_id : undefined,
    );
    if (!botUserId) {
      throw new Error('Slack auth.test did not return a bot user id.');
    }

    nextApp.event('message', async ({ event }) => {
      await handleIncomingSlackEvent(event as unknown, handler.messageHandler);
    });
    nextApp.event('app_mention', async ({ event }) => {
      await handleIncomingSlackEvent(event as unknown, handler.messageHandler);
    });
    for (const commandName of getSlackNativeSlashCommandNames()) {
      nextApp.command(`/${commandName}`, async ({ ack, command, respond }) => {
        await ack();

        const routing = buildSlackNativeCommandRouting(
          command as SlackSlashCommandPayload,
        );
        if (!routing) {
          const fallbackTarget = normalizeSlackChannelId(command.channel_id)
            ? buildSlackChannelTarget(String(command.channel_id))
            : null;
          await respondToSlackSlashCommand(
            respond,
            fallbackTarget,
            'This Slack command is not available in this conversation.',
          ).catch(() => undefined);
          return;
        }

        const args = resolveSlackNativeSlashCommandArgs({
          commandName,
          text: command.text,
        });
        if (!args || args.length === 0) {
          await respondToSlackSlashCommand(
            respond,
            routing.target,
            'Unsupported slash command.',
          );
          return;
        }

        rememberActiveSlackSession(routing.sessionId, {
          target: routing.target,
          channelId: routing.channelId,
          isDm: routing.isDm,
          threadTs: null,
        });

        try {
          const username = await resolveSlackDisplayName(routing.userId);
          const reply: SlackCommandReplyFn = async (content) => {
            await respondToSlackSlashCommand(respond, routing.target, content);
          };
          for (const commandArgs of args) {
            await handler.commandHandler(
              routing.sessionId,
              routing.guildId,
              routing.target,
              routing.userId,
              username,
              commandArgs,
              reply,
            );
          }
        } catch (error) {
          logger.error(
            {
              error,
              channelId: routing.channelId,
              userId: routing.userId,
              command: commandName,
            },
            'Slack slash command failed',
          );
          await respondToSlackSlashCommand(
            respond,
            routing.target,
            formatSlackMrkdwn(
              `**Gateway Error:** ${error instanceof Error ? error.message : String(error)}`,
            ),
          ).catch(() => undefined);
        }
      });
    }
    nextApp.action(/^approve:(yes|session|agent|all|no)$/, async (payload) => {
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
        await handler.commandHandler(
          pending.sessionId,
          null,
          approvalTarget || buildSlackChannelTarget(channelId),
          userId,
          username,
          ['approve', parsed.action, parsed.approvalId],
          async (content) => {
            if (!approvalTarget) {
              throw new Error(
                'Slack approval action is missing a reply target.',
              );
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
        rollbackPendingApprovalClaim({
          sessionId: pending.sessionId,
          approvalId: parsed.approvalId,
        });
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

    await nextApp.start();
  } catch (error) {
    if (app === nextApp) {
      app = null;
    }
    botUserId = '';
    await nextApp.stop?.().catch(() => undefined);
    throw error;
  }
}

const slackRuntime = createChannelRuntime<{
  commandHandler: SlackCommandHandler;
  messageHandler: SlackMessageHandler;
}>()({
  kind: 'slack',
  capabilities: SLACK_CAPABILITIES,
  start: async ({ handler }) => {
    await startSlackRuntime(handler);
  },
  cleanup: async () => {
    activeSlackSessions.clear();
    activeThreadKeys.clear();
    seenEventKeys.clear();
    userDisplayNameCache.clear();
    botUserId = '';
    const activeApp = app;
    app = null;
    await activeApp?.stop();
  },
});

export async function initSlack(
  messageHandler: SlackMessageHandler,
  commandHandler: SlackCommandHandler,
): Promise<void> {
  await slackRuntime.init({
    commandHandler,
    messageHandler,
  });
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
  return touchActiveSlackSession(sessionId) !== null;
}

export async function sendToActiveSlackSession(
  params: SlackActiveSessionSendParams,
): Promise<{
  channelId: string;
  attachmentCount: number;
}> {
  const session = touchActiveSlackSession(params.sessionId);
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
  await slackRuntime.shutdown();
}
