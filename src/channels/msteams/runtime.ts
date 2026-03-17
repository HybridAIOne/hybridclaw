import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Request as BotFrameworkRequest,
  type Response as BotFrameworkResponse,
  CloudAdapter,
} from 'botbuilder';
import {
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  type TurnContext,
} from 'botbuilder-core';
import {
  type Activity,
  ActivityTypes,
  type Attachment,
  type ConversationReference,
} from 'botframework-schema';
import {
  MSTEAMS_APP_ID,
  MSTEAMS_APP_PASSWORD,
  MSTEAMS_ENABLED,
  MSTEAMS_TENANT_ID,
} from '../../config/config.js';
import { logger } from '../../logger.js';
import { getMemoryValue, setMemoryValue } from '../../memory/db.js';
import type { MediaContextItem } from '../../types.js';
import { MSTEAMS_CAPABILITIES } from '../channel.js';
import { registerChannel } from '../channel-registry.js';
import {
  buildTeamsAttachmentContext,
  buildTeamsUploadedFileAttachment,
  maybeHandleMSTeamsFileConsentInvoke,
} from './attachments.js';
import { sendChunkedReply } from './delivery.js';
import {
  buildSessionIdFromActivity,
  cleanIncomingContent,
  extractActorIdentity,
  extractPrimaryText,
  extractTeamsTeamId,
  hasBotMention,
  isTeamsDm,
  parseCommand,
} from './inbound.js';
import {
  type ResolveMSTeamsChannelPolicyResult,
  resolveMSTeamsChannelPolicy,
} from './send-permissions.js';
import { MSTeamsStreamManager } from './stream.js';
import { createMSTeamsTypingController } from './typing.js';
import {
  isRecord,
  MSTEAMS_CONVERSATION_REFERENCE_KEY,
  normalizeOptionalValue,
  normalizeValue,
} from './utils.js';

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
// Teams activities are small control payloads; media is fetched separately.
// Keep the shared-port webhook reader on a tight cap to avoid unbounded buffering.
const MAX_WEBHOOK_BYTES = 1_000_000;
const ACTIVE_MSTEAMS_SESSIONS = new Map<string, ActiveMSTeamsSession>();

type ParsedWebhookRequest = IncomingMessage &
  BotFrameworkRequest<Record<string, unknown>>;

interface ActiveMSTeamsSession {
  channelId: string;
  isDm: boolean;
  replyStyle: ResolveMSTeamsChannelPolicyResult['replyStyle'];
  replyToId?: string | null;
  reference?: Partial<ConversationReference> | null;
  turnContext: TurnContext;
}

interface StoredMSTeamsSession {
  channelId: string;
  isDm: boolean;
  replyStyle: ResolveMSTeamsChannelPolicyResult['replyStyle'];
  replyToId: string | null;
  reference: Partial<ConversationReference>;
}

function resolveWebhookAuthFailureStatus(error: unknown): 401 | 403 | null {
  if (!isRecord(error)) {
    return null;
  }
  const rawStatus = error.statusCode ?? error.status;
  const statusCode =
    typeof rawStatus === 'number'
      ? rawStatus
      : Number.isFinite(Number(rawStatus))
        ? Number(rawStatus)
        : null;
  if (statusCode === 401 || statusCode === 403) {
    return statusCode;
  }

  const name = normalizeValue(String(error.name || '')).toLowerCase();
  const code = normalizeValue(String(error.code || '')).toLowerCase();
  if (
    name === 'authenticationerror' ||
    code === 'authenticationerror' ||
    code === 'unauthorized'
  ) {
    return 401;
  }

  return null;
}

function shouldShowTypingForCommand(args: string[]): boolean {
  const command = normalizeValue(args[0]).toLowerCase();
  if (command !== 'approve') {
    return false;
  }
  const action = normalizeValue(args[1]).toLowerCase();
  return action !== 'view';
}

function buildConversationReference(
  activity: Activity,
): Partial<ConversationReference> | null {
  const channelId = normalizeValue(activity.channelId);
  const serviceUrl = normalizeValue(activity.serviceUrl);
  const conversationId = normalizeValue(activity.conversation?.id);
  const botId = normalizeValue(activity.recipient?.id);
  if (!channelId || !serviceUrl || !conversationId || !botId) {
    return null;
  }

  const reference: Partial<ConversationReference> = {
    bot: activity.recipient,
    channelId,
    conversation: activity.conversation,
    serviceUrl,
    user: activity.from,
  };
  const activityId = normalizeValue(activity.id);
  const locale = normalizeValue(activity.locale);
  if (activityId) {
    reference.activityId = activityId;
  }
  if (locale) {
    reference.locale = locale;
  }
  return reference;
}

function persistConversationReference(
  sessionId: string,
  session: StoredMSTeamsSession,
): void {
  setMemoryValue(sessionId, MSTEAMS_CONVERSATION_REFERENCE_KEY, session);
}

function readStoredConversationReference(
  sessionId: string,
): StoredMSTeamsSession | null {
  const stored = getMemoryValue(sessionId, MSTEAMS_CONVERSATION_REFERENCE_KEY);
  if (!isRecord(stored)) {
    return null;
  }

  const channelId = normalizeOptionalValue(stored.channelId);
  const isDm = typeof stored.isDm === 'boolean' ? stored.isDm : null;
  const replyStyle =
    stored.replyStyle === 'thread' || stored.replyStyle === 'top-level'
      ? stored.replyStyle
      : null;
  const referenceValue = isRecord(stored.reference) ? stored.reference : null;
  if (!channelId || isDm == null || !replyStyle || !referenceValue) {
    return null;
  }

  const referenceChannelId = normalizeOptionalValue(referenceValue.channelId);
  const serviceUrl = normalizeOptionalValue(referenceValue.serviceUrl);
  const conversation = isRecord(referenceValue.conversation)
    ? referenceValue.conversation
    : null;
  const bot = isRecord(referenceValue.bot) ? referenceValue.bot : null;
  if (
    !referenceChannelId ||
    !serviceUrl ||
    !conversation ||
    !normalizeOptionalValue(conversation.id) ||
    !bot ||
    !normalizeOptionalValue(bot.id)
  ) {
    return null;
  }

  return {
    channelId,
    isDm,
    reference: {
      activityId:
        normalizeOptionalValue(referenceValue.activityId) || undefined,
      bot: bot as unknown as ConversationReference['bot'],
      channelId: referenceChannelId,
      conversation:
        conversation as unknown as ConversationReference['conversation'],
      locale: normalizeOptionalValue(referenceValue.locale) || undefined,
      serviceUrl,
      user: isRecord(referenceValue.user)
        ? (referenceValue.user as unknown as ConversationReference['user'])
        : undefined,
    },
    replyStyle,
    replyToId: normalizeOptionalValue(stored.replyToId),
  };
}

async function buildTeamsMessageAttachments(
  turnContext: TurnContext,
  params: {
    filePath?: string | null;
    filename?: string | null;
    mimeType?: string | null;
  },
): Promise<Attachment[] | undefined> {
  if (!normalizeValue(params.filePath)) {
    return undefined;
  }
  return [
    await buildTeamsUploadedFileAttachment({
      turnContext,
      filePath: params.filePath as string,
      filename: params.filename,
      mimeType: params.mimeType,
    }),
  ];
}

async function sendViaConversationReference(
  session: Pick<
    StoredMSTeamsSession,
    'isDm' | 'reference' | 'replyStyle' | 'replyToId'
  >,
  params: {
    text: string;
    filePath?: string | null;
    filename?: string | null;
    mimeType?: string | null;
  },
): Promise<number> {
  let attachmentCount = 0;
  await ensureTeamsRuntimeReady().continueConversationAsync(
    MSTEAMS_APP_ID,
    session.reference,
    async (proactiveContext) => {
      const attachments = await buildTeamsMessageAttachments(
        proactiveContext,
        params,
      );
      attachmentCount = attachments?.length || 0;
      await sendChunkedReply({
        turnContext: proactiveContext,
        text: params.text,
        attachments,
        replyStyle:
          attachmentCount > 0 && session.isDm
            ? 'top-level'
            : session.replyStyle,
        replyToId:
          attachmentCount > 0 && session.isDm ? null : session.replyToId,
      });
    },
  );
  return attachmentCount;
}

async function readWebhookBody(
  req: ParsedWebhookRequest,
): Promise<Record<string, unknown>> {
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
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Microsoft Teams webhook body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
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

function normalizeHeaderValue(
  value: unknown,
): string | number | readonly string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === 'number') {
    return value;
  }
  return String(value);
}

// CloudAdapter.process() expects an Express-style response object, but the
// gateway mounts Teams on the shared Node HTTP server. This shim adapts the
// native ServerResponse without introducing a second web framework layer.
function createAdapterResponse(res: ServerResponse): BotFrameworkResponse {
  const response: BotFrameworkResponse = {
    socket: res.socket,
    header(name, value) {
      if (!res.headersSent) {
        res.setHeader(name, normalizeHeaderValue(value));
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
    const storedSession = readStoredConversationReference(sessionId);
    if (!storedSession) {
      throw new Error(
        'Teams message sends currently require an active or previously stored Teams conversation. Retry from the same Teams chat after HybridClaw has seen a message there.',
      );
    }
    const attachmentCount = await sendViaConversationReference(
      storedSession,
      params,
    );
    return {
      attachmentCount,
      channelId: storedSession.channelId,
    };
  }

  if (normalizeValue(params.filePath) && activeSession.isDm) {
    const reference =
      activeSession.reference ||
      buildConversationReference(
        activeSession.turnContext.activity as Activity,
      );
    if (!reference) {
      throw new Error(
        'Teams DM attachment sends require a valid conversation reference.',
      );
    }
    const attachmentCount = await sendViaConversationReference(
      {
        isDm: activeSession.isDm,
        reference,
        replyStyle: activeSession.replyStyle,
        replyToId: activeSession.replyToId || null,
      },
      params,
    );
    return {
      attachmentCount,
      channelId: activeSession.channelId,
    };
  }

  const attachments = await buildTeamsMessageAttachments(
    activeSession.turnContext,
    params,
  );
  if (!attachments?.length || !activeSession.isDm) {
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
    } catch (replyError) {
      logger.warn(
        { error: replyError },
        'Failed to send Teams turn failure notice',
      );
    }
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
  const primaryText = extractPrimaryText(activity);
  const content = cleanIncomingContent(activity);
  const media = await buildTeamsAttachmentContext({ activity });
  const parsedCommand = parseCommand(primaryText);
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
  const reference = buildConversationReference(activity);
  if (reference) {
    persistConversationReference(sessionId, {
      channelId,
      isDm,
      reference,
      replyStyle: policy.replyStyle,
      replyToId: normalizeOptionalValue(activity.id),
    });
  }
  const releaseActiveSession = registerActiveMSTeamsSession(sessionId, {
    channelId,
    isDm,
    reference,
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
        },
      );
    } finally {
      typingController.stop();
    }
  } finally {
    releaseActiveSession();
  }
}

export function initMSTeams(
  onMessage: MessageHandler,
  onCommand: CommandHandler,
): void {
  if (typeof onMessage !== 'function' || typeof onCommand !== 'function') {
    throw new Error(
      'Teams runtime requires both message and command handlers during initialization.',
    );
  }
  messageHandler = onMessage;
  commandHandler = onCommand;
  registerChannel({
    kind: 'msteams',
    id: 'msteams',
    capabilities: MSTEAMS_CAPABILITIES,
  });
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
  try {
    // CloudAdapter.process() performs the Bot Framework auth/token validation
    // before invoking the turn logic. This shared-port webhook only adapts the
    // raw Node request/response into the shape the adapter expects.
    await activeAdapter.process(
      request,
      createAdapterResponse(res),
      async (turnContext) => {
        if (await maybeHandleMSTeamsFileConsentInvoke(turnContext)) {
          return;
        }
        await handleIncomingMessage(turnContext);
      },
    );
  } catch (error) {
    const authStatus = resolveWebhookAuthFailureStatus(error);
    if (authStatus) {
      logger.warn(
        { error, statusCode: authStatus },
        'Rejected Teams webhook due to Bot Framework authentication failure',
      );
      if (!res.headersSent && !res.writableEnded) {
        res.statusCode = authStatus;
        res.end();
      }
      return;
    }
    throw error;
  }
}
