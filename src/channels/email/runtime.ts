import nodemailer, { type Transporter } from 'nodemailer';
import { EMAIL_PASSWORD, getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types.js';
import { createEmailConnectionManager } from './connection.js';
import { sendEmailReply, sendEmailWithAttachment } from './delivery.js';
import { cleanupEmailInboundMedia, processInboundEmail } from './inbound.js';
import { createThreadTracker, type ThreadContext } from './threading.js';

export type EmailReplyFn = (content: string) => Promise<void>;

export interface EmailMessageContext {
  abortSignal: AbortSignal;
  folder: string;
  uid: number;
  senderAddress: string;
  senderName: string;
  threadContext: ThreadContext | null;
}

export type EmailMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: EmailReplyFn,
  context: EmailMessageContext,
) => Promise<void>;

export interface EmailAttachmentSendParams {
  to: string;
  filePath: string;
  body?: string;
  filename?: string | null;
  mimeType?: string | null;
}

export interface EmailRuntime {
  initEmail: (messageHandler: EmailMessageHandler) => Promise<void>;
  sendToEmail: (to: string, text: string) => Promise<void>;
  sendEmailAttachmentTo: (params: EmailAttachmentSendParams) => Promise<void>;
  shutdownEmail: () => Promise<void>;
}

function resolveRuntimeConfig(): {
  address: string;
  config: ReturnType<typeof getConfigSnapshot>['email'];
  password: string;
} {
  const snapshot = getConfigSnapshot();
  const config = snapshot.email;
  const password = String(EMAIL_PASSWORD || '').trim();
  if (!config.enabled) {
    throw new Error('Email channel is not enabled.');
  }
  if (!config.address.trim()) {
    throw new Error('Email channel address is not configured.');
  }
  if (!config.imapHost.trim()) {
    throw new Error('Email IMAP host is not configured.');
  }
  if (!config.smtpHost.trim()) {
    throw new Error('Email SMTP host is not configured.');
  }
  if (!password) {
    throw new Error('EMAIL_PASSWORD is required to start the email channel.');
  }
  return {
    address: config.address.trim(),
    config,
    password,
  };
}

export function createEmailRuntime(): EmailRuntime {
  let connectionManager: ReturnType<
    typeof createEmailConnectionManager
  > | null = null;
  let transport: Transporter | null = null;
  let threadTracker: ReturnType<typeof createThreadTracker> | null = null;
  let runtimeInitialized = false;

  const ensureThreadTracker = (): ReturnType<typeof createThreadTracker> => {
    threadTracker ??= createThreadTracker();
    return threadTracker;
  };

  const ensureTransport = async (): Promise<Transporter> => {
    if (transport) return transport;

    const { address, config, password } = resolveRuntimeConfig();
    transport = nodemailer.createTransport({
      pool: true,
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: address,
        pass: password,
      },
    });
    await transport.verify();
    return transport;
  };

  const sendTextToAddress = async (to: string, text: string): Promise<void> => {
    const tracker = ensureThreadTracker();
    const transport = await ensureTransport();
    const { address } = resolveRuntimeConfig();
    const result = await sendEmailReply(
      transport,
      to,
      text,
      address,
      tracker.get(to),
    );
    if (result.threadContext) {
      tracker.remember(to, result.threadContext);
    }
  };

  const sendAttachmentToAddress = async (
    params: EmailAttachmentSendParams,
  ): Promise<void> => {
    const tracker = ensureThreadTracker();
    const transport = await ensureTransport();
    const { address } = resolveRuntimeConfig();
    const result = await sendEmailWithAttachment(
      transport,
      params.to,
      params.body || '',
      address,
      params.filePath,
      tracker.get(params.to),
      {
        filename: params.filename || null,
        mimeType: params.mimeType || null,
      },
    );
    if (result.threadContext) {
      tracker.remember(params.to, result.threadContext);
    }
  };

  const ensureConnectionManager = (
    messageHandler?: EmailMessageHandler,
  ): ReturnType<typeof createEmailConnectionManager> => {
    if (connectionManager) return connectionManager;

    const { address, config, password } = resolveRuntimeConfig();
    const tracker = ensureThreadTracker();
    connectionManager = createEmailConnectionManager(
      config,
      password,
      async (messages) => {
        if (!messageHandler) return;
        for (const message of messages) {
          const inbound = await processInboundEmail(
            message.raw,
            getConfigSnapshot().email,
            address,
          );
          if (!inbound) continue;

          if (inbound.threadContext) {
            tracker.remember(inbound.senderAddress, inbound.threadContext);
          }

          const controller = new AbortController();
          const reply: EmailReplyFn = async (content) => {
            await sendTextToAddress(inbound.channelId, content);
          };

          try {
            await messageHandler(
              inbound.sessionId,
              inbound.guildId,
              inbound.channelId,
              inbound.userId,
              inbound.username,
              inbound.content,
              inbound.media,
              reply,
              {
                abortSignal: controller.signal,
                folder: message.folder,
                uid: message.uid,
                senderAddress: inbound.senderAddress,
                senderName: inbound.senderName,
                threadContext: inbound.threadContext,
              },
            );
          } finally {
            await cleanupEmailInboundMedia(inbound.media).catch((error) => {
              logger.debug(
                {
                  error,
                  sessionId: inbound.sessionId,
                  channelId: inbound.channelId,
                },
                'Failed to clean up email inbound media',
              );
            });
          }
        }
      },
    );
    return connectionManager;
  };

  return {
    async initEmail(messageHandler: EmailMessageHandler): Promise<void> {
      if (runtimeInitialized) return;
      runtimeInitialized = true;
      await ensureTransport();
      await ensureConnectionManager(messageHandler).start();
    },
    async sendToEmail(to: string, text: string): Promise<void> {
      await sendTextToAddress(to, text);
    },
    async sendEmailAttachmentTo(
      params: EmailAttachmentSendParams,
    ): Promise<void> {
      await sendAttachmentToAddress(params);
    },
    async shutdownEmail(): Promise<void> {
      await connectionManager?.stop();
      await transport?.close();
      connectionManager = null;
      transport = null;
      threadTracker?.clear();
      threadTracker = null;
      runtimeInitialized = false;
    },
  };
}

let defaultRuntime: EmailRuntime | null = null;

function ensureDefaultRuntime(): EmailRuntime {
  defaultRuntime ??= createEmailRuntime();
  return defaultRuntime;
}

export async function initEmail(
  messageHandler: EmailMessageHandler,
): Promise<void> {
  await ensureDefaultRuntime().initEmail(messageHandler);
}

export async function sendToEmail(to: string, text: string): Promise<void> {
  await ensureDefaultRuntime().sendToEmail(to, text);
}

export async function sendEmailAttachmentTo(
  params: EmailAttachmentSendParams,
): Promise<void> {
  await ensureDefaultRuntime().sendEmailAttachmentTo(params);
}

export async function shutdownEmail(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = null;
  await runtime?.shutdownEmail();
}
