import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { EMAIL_PASSWORD, getConfigSnapshot } from '../../config/config.js';
import { logger } from '../../logger.js';
import type { MediaContextItem } from '../../types/container.js';
import { EMAIL_CAPABILITIES } from '../channel.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import { createEmailConnectionManager } from './connection.js';
import { type EmailSendParams, sendEmail } from './delivery.js';
import { cleanupEmailInboundMedia, processInboundEmail } from './inbound.js';
import { resolveSentFolderPath } from './mailbox-folders.js';
import type { EmailDeliveryMetadata } from './metadata.js';
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
  subject?: string | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  filename?: string | null;
  mimeType?: string | null;
  metadata?: EmailDeliveryMetadata | null;
}

export interface EmailTextSendOptions {
  subject?: string | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  metadata?: EmailDeliveryMetadata | null;
}

function createEmailShutdownAbortError(): Error {
  return new Error('Email runtime shutting down.');
}

async function appendSentCopiesToImap(
  config: ReturnType<typeof getConfigSnapshot>['email'],
  password: string,
  sentCopies: Array<{ messageId: string | null; raw: Buffer }>,
): Promise<void> {
  if (sentCopies.length === 0) return;

  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapSecure,
    auth: {
      user: config.address,
      pass: password,
    },
    disableAutoIdle: true,
    logger: false,
  });

  await client.connect();
  try {
    const sentFolder = await resolveSentFolderPath(client);
    if (!sentFolder) {
      return;
    }

    const lock = await client.getMailboxLock(sentFolder);
    try {
      for (const sentCopy of sentCopies) {
        if (sentCopy.messageId) {
          const existing =
            (await client.search(
              { header: { 'message-id': sentCopy.messageId } },
              { uid: true },
            )) || [];
          if (existing.length > 0) {
            continue;
          }
        }
        await client.append(sentFolder, sentCopy.raw, ['\\Seen'], new Date());
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {
      client.close();
    });
  }
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

export function createEmailRuntime() {
  type ResolvedRuntimeConfig = ReturnType<typeof resolveRuntimeConfig>;

  let connectionManager: ReturnType<
    typeof createEmailConnectionManager
  > | null = null;
  let shuttingDown = false;
  let runtimeConfig: ResolvedRuntimeConfig | null = null;
  let transport: Transporter | null = null;
  let threadTracker: ReturnType<typeof createThreadTracker> | null = null;
  const inFlightControllers = new Set<AbortController>();

  const ensureRuntimeActive = (): void => {
    if (shuttingDown) {
      throw createEmailShutdownAbortError();
    }
  };

  const ensureRuntimeConfig = (): ResolvedRuntimeConfig => {
    runtimeConfig ??= resolveRuntimeConfig();
    return runtimeConfig;
  };

  const ensureThreadTracker = (): ReturnType<typeof createThreadTracker> => {
    threadTracker ??= createThreadTracker();
    return threadTracker;
  };

  const abortInFlightHandlers = (): void => {
    for (const controller of inFlightControllers) {
      if (controller.signal.aborted) continue;
      controller.abort(createEmailShutdownAbortError());
    }
  };

  const ensureTransport = async (): Promise<Transporter> => {
    ensureRuntimeActive();
    if (transport) return transport;

    const { address, config, password } = ensureRuntimeConfig();
    transport = nodemailer.createTransport({
      pool: true,
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpSecure,
      auth: {
        user: address,
        pass: password,
      },
    });
    await transport.verify();
    return transport;
  };

  const sendWithTracking = async (
    params: Omit<
      EmailSendParams,
      'selfAddress' | 'threadContext' | 'transport'
    >,
  ): Promise<void> => {
    ensureRuntimeActive();
    const tracker = ensureThreadTracker();
    const transport = await ensureTransport();
    const runtime = ensureRuntimeConfig();
    const { address } = runtime;
    const result = await sendEmail({
      ...params,
      transport,
      selfAddress: address,
      threadContext: tracker.get(params.to),
    });
    await appendSentCopiesToImap(
      runtime.config,
      runtime.password,
      result.sentCopies,
    ).catch((error) => {
      logger.warn(
        {
          error,
          to: params.to,
          sentCopyCount: result.sentCopies.length,
        },
        'Failed to append sent email copy to IMAP Sent folder',
      );
    });
    if (result.threadContext) {
      tracker.remember(params.to, result.threadContext);
    }
  };

  const sendTextToAddress = async (
    to: string,
    text: string,
    options?: EmailTextSendOptions,
  ): Promise<void> => {
    await sendWithTracking({
      to,
      body: text,
      subject: options?.subject,
      cc: options?.cc,
      bcc: options?.bcc,
      inReplyTo: options?.inReplyTo,
      references: options?.references,
      metadata: options?.metadata,
    });
  };

  const sendAttachmentToAddress = async (
    params: EmailAttachmentSendParams,
  ): Promise<void> => {
    await sendWithTracking({
      to: params.to,
      body: params.body || '',
      subject: params.subject,
      cc: params.cc,
      bcc: params.bcc,
      inReplyTo: params.inReplyTo,
      references: params.references,
      metadata: params.metadata,
      attachment: {
        filePath: params.filePath,
        filename: params.filename || null,
        mimeType: params.mimeType || null,
      },
    });
  };

  const ensureConnectionManager = (
    messageHandler?: EmailMessageHandler,
  ): ReturnType<typeof createEmailConnectionManager> => {
    if (connectionManager) return connectionManager;

    const { address, config, password } = ensureRuntimeConfig();
    const tracker = ensureThreadTracker();
    connectionManager = createEmailConnectionManager(
      config,
      password,
      async (messages) => {
        if (!messageHandler || shuttingDown) return;
        for (const message of messages) {
          if (shuttingDown) break;
          const inbound = await processInboundEmail(
            message.raw,
            config,
            address,
          );
          if (!inbound) continue;

          if (inbound.threadContext) {
            tracker.remember(inbound.senderAddress, inbound.threadContext);
          }

          const controller = new AbortController();
          inFlightControllers.add(controller);
          if (shuttingDown && !controller.signal.aborted) {
            controller.abort(createEmailShutdownAbortError());
          }
          const reply: EmailReplyFn = async (content) => {
            if (controller.signal.aborted) {
              const reason = controller.signal.reason;
              throw reason instanceof Error
                ? reason
                : createEmailShutdownAbortError();
            }
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
            inFlightControllers.delete(controller);
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
  const runtimeLifecycle = createChannelRuntime<EmailMessageHandler>()({
    kind: 'email',
    capabilities: EMAIL_CAPABILITIES,
    resolveConfig: () => {
      ensureRuntimeActive();
      return ensureRuntimeConfig();
    },
    resolveRegistration: (config) => config.address,
    start: async (params: {
      config: ResolvedRuntimeConfig;
      handler: EmailMessageHandler;
    }) => {
      await ensureTransport();
      await ensureConnectionManager(params.handler).start();
    },
    cleanup: async () => {
      shuttingDown = true;
      abortInFlightHandlers();
      await connectionManager?.stop();
      await transport?.close();
      connectionManager = null;
      runtimeConfig = null;
      transport = null;
      threadTracker?.clear();
      threadTracker = null;
    },
  });

  return {
    initEmail: runtimeLifecycle.init,
    async sendToEmail(
      to: string,
      text: string,
      options?: EmailTextSendOptions,
    ): Promise<void> {
      await sendTextToAddress(to, text, options);
    },
    async sendEmailAttachmentTo(
      params: EmailAttachmentSendParams,
    ): Promise<void> {
      await sendAttachmentToAddress(params);
    },
    shutdownEmail: runtimeLifecycle.shutdown,
  };
}

let defaultRuntime: ReturnType<typeof createEmailRuntime> | null = null;

function ensureDefaultRuntime(): ReturnType<typeof createEmailRuntime> {
  defaultRuntime ??= createEmailRuntime();
  return defaultRuntime;
}

export const initEmail = (messageHandler: EmailMessageHandler): Promise<void> =>
  ensureDefaultRuntime().initEmail(messageHandler);

export const sendToEmail = (
  to: string,
  text: string,
  options?: EmailTextSendOptions,
): Promise<void> => ensureDefaultRuntime().sendToEmail(to, text, options);

export const sendEmailAttachmentTo = (
  params: EmailAttachmentSendParams,
): Promise<void> => ensureDefaultRuntime().sendEmailAttachmentTo(params);

export async function shutdownEmail(): Promise<void> {
  const runtime = defaultRuntime;
  defaultRuntime = null;
  await runtime?.shutdownEmail();
}
