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
import { buildTeamsAttachmentContext } from './attachments.js';
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

function normalizeValue(value: string | null | undefined): string {
  return String(value || '').trim();
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
  const media = buildTeamsAttachmentContext({ activity });
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

  if (parsedCommand.isCommand) {
    await commandHandler(
      sessionId,
      teamId,
      channelId,
      actor.userId,
      username,
      [parsedCommand.command, ...parsedCommand.args],
      reply,
    );
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
  await activeAdapter.process(
    req as never,
    res as never,
    async (turnContext) => {
      await handleIncomingMessage(turnContext);
    },
  );
}
