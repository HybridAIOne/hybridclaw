import type { IncomingMessage, ServerResponse } from 'node:http';
import { CloudAdapter } from 'botbuilder';
import {
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  type TurnContext,
} from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
} from 'botframework-schema';
import {
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  MSTEAMS_ENABLED,
  MSTEAMS_TENANT_ID,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';
import {
  buildTeamsAttachmentContext,
  buildTeamsUploadedFileAttachment,
} from './attachments.js';
import { sendChunkedReply } from './delivery.js';
import {
  buildSessionIdFromActivity,
  cleanIncomingContent,
  extractActorIdentity,
  extractTeamsTeamId,
  hasBotMention,
  isTeamsDm,
  parseCommand,
} from './inbound.js';
import {
  createMSTeamsReactionController,
  type MSTeamsLifecyclePhase,
} from './reactions.js';
import {
  type ResolveMSTeamsChannelPolicyResult,
  resolveMSTeamsChannelPolicy,
} from './send-permissions.js';
import { MSTeamsStreamManager } from './stream.js';
import { createMSTeamsTypingController } from './typing.js';

export type ReplyFn = (
  content: string,
  attachments?: Attachment[],
) => Promise<void>;

export interface MSTeamsMessageContext {
  activity: Activity;
  turnContext: TurnContext;
  abortSignal: AbortSignal;
  stream: MSTeamsStreamManager;
  policy: ResolveMSTeamsChannelPolicyResult;
  emitLifecyclePhase: (phase: MSTeamsLifecyclePhase) => void;
}

export type MessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: ReplyFn,
  context: MSTeamsMessageContext,
) => Promise<void>;

export type CommandHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  args: string[],
  reply: ReplyFn,
) => Promise<void>;

let adapter: CloudAdapter | null = null;
let messageHandler: MessageHandler | null = null;
let commandHandler: CommandHandler | null = null;
let adapterSignature = '';
const MAX_WEBHOOK_BYTES = 1_000_000;
const ACTIVE_MSTEAMS_SESSIONS = new Map<string, ActiveMSTeamsSession>();

type ParsedWebhookRequest = IncomingMessage & { body?: unknown };

interface ActiveMSTeamsSession {
  channelId: string;
  isDm: boolean;
  replyStyle: ResolveMSTeamsChannelPolicyResult['replyStyle'];
  replyToId?: string | null;
  turnContext: TurnContext;
}

interface AdapterCompatibleResponse {
  header(name: string, value: string): AdapterCompatibleResponse;
  status(statusCode: number): AdapterCompatibleResponse;
  send(body?: unknown): AdapterCompatibleResponse;
  end(chunk?: unknown): AdapterCompatibleResponse;
}

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
}

function shouldShowTypingForCommand(args: string[]): boolean {
  const command = normalizeValue(args[0]).toLowerCase();
  if (command !== 'approve') {
    return false;
  }
  const action = normalizeValue(args[1]).toLowerCase();
  return action !== 'view';
}

async function readWebhookBody(req: ParsedWebhookRequest): Promise<unknown> {
  if (typeof req.body !== 'undefined') return req.body;

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_WEBHOOK_BYTES) {
      throw new Error('Microsoft Teams webhook body too large.');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw) as unknown;
}

function writeAdapterBody(res: ServerResponse, body: unknown): void {
  if (body == null) return;

  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.write(body);
    return;
  }

  if (!res.hasHeader('content-type')) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
  }
  res.write(JSON.stringify(body));
}

function createAdapterResponse(res: ServerResponse): AdapterCompatibleResponse {
  const response: AdapterCompatibleResponse = {
    header(name, value) {
      if (!res.headersSent) {
        res.setHeader(name, value);
      }
      return response;
    },
    status(statusCode) {
      res.statusCode = statusCode;
      return response;
    },
    send(body) {
      writeAdapterBody(res, body);
      return response;
    },
    end(chunk) {
      if (typeof chunk !== 'undefined') {
        writeAdapterBody(res, chunk);
      }
      if (!res.writableEnded) {
        res.end();
      }
      return response;
    },
  };
  return response;
}

function registerActiveMSTeamsSession(
  sessionId: string,
  context: ActiveMSTeamsSession,
): () => void {
  ACTIVE_MSTEAMS_SESSIONS.set(sessionId, context);
  return () => {
    if (ACTIVE_MSTEAMS_SESSIONS.get(sessionId) === context) {
      ACTIVE_MSTEAMS_SESSIONS.delete(sessionId);
    }
  };
}

export function hasActiveMSTeamsSession(sessionId: string): boolean {
  return ACTIVE_MSTEAMS_SESSIONS.has(normalizeValue(sessionId));
}

export async function sendToActiveMSTeamsSession(params: {
  sessionId: string;
  text: string;
  filePath?: string | null;
  filename?: string | null;
  mimeType?: string | null;
}): Promise<{ attachmentCount: number; channelId: string }> {
  const sessionId = normalizeValue(params.sessionId);
  const activeSession = ACTIVE_MSTEAMS_SESSIONS.get(sessionId);
  if (!activeSession) {
    throw new Error(
      'Teams message sends currently require the active Teams conversation. Retry from the same Teams chat while the request is running.',
    );
  }

  const attachments =
    normalizeValue(params.filePath).length > 0
      ? [
          await buildTeamsUploadedFileAttachment({
            turnContext: activeSession.turnContext,
            filePath: params.filePath as string,
            filename: params.filename,
            mimeType: params.mimeType,
          }),
        ]
      : undefined;

  if (attachments?.length && activeSession.isDm) {
    const activity = activeSession.turnContext.activity;
    await buildAdapter().continueConversationAsync(
      MSTEAMS_APP_ID,
      {
        activityId: undefined,
        bot: activity.recipient,
        channelId: activity.channelId,
        conversation: activity.conversation,
        locale: activity.locale,
        serviceUrl: activity.serviceUrl,
        user: activity.from,
      },
      async (proactiveContext) => {
        await sendChunkedReply({
          turnContext: proactiveContext,
          text: params.text,
          attachments,
          replyStyle: 'top-level',
          replyToId: null,
        });
      },
    );
  } else {
    await sendChunkedReply({
      turnContext: activeSession.turnContext,
      text: params.text,
      attachments,
      replyStyle: activeSession.replyStyle,
      replyToId: activeSession.replyToId,
    });
  }

  return {
    attachmentCount: attachments?.length || 0,
    channelId: activeSession.channelId,
  };
}

function buildAdapter(): CloudAdapter {
  const signature = `${MSTEAMS_APP_ID}:${MSTEAMS_TENANT_ID}:${Boolean(
    MSTEAMS_APP_PASSWORD,
  )}`;
  if (adapter && adapterSignature === signature) {
    return adapter;
  }

  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: MSTEAMS_APP_ID,
    MicrosoftAppPassword: MSTEAMS_APP_PASSWORD,
    MicrosoftAppType: MSTEAMS_TENANT_ID ? 'SingleTenant' : 'MultiTenant',
    MicrosoftAppTenantId: MSTEAMS_TENANT_ID || undefined,
  });
  const auth = new ConfigurationBotFrameworkAuthentication(
    {
      MicrosoftAppId: MSTEAMS_APP_ID,
      MicrosoftAppTenantId: MSTEAMS_TENANT_ID || undefined,
    },
    credentialsFactory,
  );

  adapter = new CloudAdapter(auth);
  adapterSignature = signature;
  adapter.onTurnError = async (turnContext, error) => {
    logger.error({ error }, 'Teams turn failed');
    try {
      await turnContext.sendActivity(
        'Teams request failed before HybridClaw could reply.',
      );
    } catch {}
  };
  return adapter;
}

function ensureTeamsRuntimeReady(): CloudAdapter {
  if (!MSTEAMS_ENABLED) {
    throw new Error('Microsoft Teams integration is disabled in config.');
  }
  if (!normalizeValue(MSTEAMS_APP_ID)) {
    throw new Error('MSTEAMS_APP_ID is required to start Teams integration.');
  }
  if (!normalizeValue(MSTEAMS_APP_PASSWORD)) {
    throw new Error(
      'MSTEAMS_APP_PASSWORD is required to start Teams integration.',
    );
  }
  return buildAdapter();
}

async function handleIncomingMessage(turnContext: TurnContext): Promise<void> {
  if (!messageHandler || !commandHandler) {
    throw new Error('Teams runtime was not initialized with handlers.');
  }

  const activity = turnContext.activity as Activity;
  if (activity.type !== ActivityTypes.Message) return;

  const actor = extractActorIdentity(activity);
  if (!actor.userId) return;

  const teamId = extractTeamsTeamId(activity);
  const channelId = normalizeValue(activity.conversation?.id);
  if (!channelId) return;

  const isDm = isTeamsDm(activity);
  const policy = resolveMSTeamsChannelPolicy({
    isDm,
    teamId,
    channelId,
    actor,
  });
  if (!policy.allowed) {
    logger.debug(
      {
        teamId: teamId || null,
        channelId,
        userId: actor.userId,
        reason: policy.reason || null,
      },
      'Ignored Teams activity due to channel policy',
    );
    return;
  }

  const hasMention = hasBotMention(activity, activity.recipient?.id);
  const content = cleanIncomingContent(activity);
  const media = await buildTeamsAttachmentContext({ activity });
  const parsedCommand = parseCommand(content);
  if (
    !parsedCommand.isCommand &&
    !isDm &&
    policy.requireMention &&
    !hasMention
  ) {
    return;
  }
  if (!content.trim() && media.length === 0) return;

  const reply: ReplyFn = async (text, attachments) => {
    await sendChunkedReply({
      turnContext,
      text,
      attachments,
      replyStyle: policy.replyStyle,
      replyToId: activity.id,
    });
  };

  const sessionId = buildSessionIdFromActivity(activity);
  const username =
    actor.displayName || actor.username || actor.aadObjectId || actor.userId;
  const releaseActiveSession = registerActiveMSTeamsSession(sessionId, {
    channelId,
    isDm,
    replyStyle: policy.replyStyle,
    replyToId: activity.id,
    turnContext,
  });
  try {
    if (parsedCommand.isCommand) {
      const commandArgs = [parsedCommand.command, ...parsedCommand.args];
      const typingController = createMSTeamsTypingController(turnContext);
      const showTyping = shouldShowTypingForCommand(commandArgs);
      if (showTyping) typingController.start();
      try {
        await commandHandler(
          sessionId,
          teamId,
          channelId,
          actor.userId,
          username,
          commandArgs,
          reply,
        );
      } finally {
        if (showTyping) typingController.stop();
      }
      return;
    }

    const abortController = new AbortController();
    const stream = new MSTeamsStreamManager(turnContext, {
      replyStyle: policy.replyStyle,
      replyToId: activity.id,
    });
    const typingController = createMSTeamsTypingController(turnContext);
    const reactionController = createMSTeamsReactionController();

    typingController.start();
    try {
      await messageHandler(
        sessionId,
        teamId,
        channelId,
        actor.userId,
        username,
        content,
        media,
        reply,
        {
          activity,
          turnContext,
          abortSignal: abortController.signal,
          stream,
          policy,
          emitLifecyclePhase: (phase) => reactionController.setPhase(phase),
        },
      );
    } finally {
      typingController.stop();
      await reactionController.clear();
    }
  } finally {
    releaseActiveSession();
  }
}

export function initMSTeams(
  onMessage: MessageHandler,
  onCommand: CommandHandler,
): void {
  messageHandler = onMessage;
  commandHandler = onCommand;
  if (!MSTEAMS_ENABLED) return;
  if (
    !normalizeValue(MSTEAMS_APP_ID) ||
    !normalizeValue(MSTEAMS_APP_PASSWORD)
  ) {
    return;
  }
  buildAdapter();
}

export async function handleMSTeamsWebhook(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const activeAdapter = ensureTeamsRuntimeReady();
  const request = req as ParsedWebhookRequest;
  request.body = await readWebhookBody(request);
  await activeAdapter.process(
    request as never,
    createAdapterResponse(res) as never,
    async (turnContext) => {
      await handleIncomingMessage(turnContext);
    },
  );
}
