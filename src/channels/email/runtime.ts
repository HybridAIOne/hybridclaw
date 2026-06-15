import { ImapFlow } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { EMAIL_PASSWORD, getConfigSnapshot } from '../../config/config.js';
import type {
  RuntimeEmailAccountConfig,
  RuntimeEmailConfig,
} from '../../config/runtime-config.js';
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

type EmailAccountConfig = RuntimeEmailAccountConfig;

type EmailAppendSentConfig = Pick<
  EmailAccountConfig,
  'address' | 'imapHost' | 'imapPort' | 'imapSecure'
>;

interface ResolvedEmailAccount {
  key: string;
  agentId: string;
  address: string;
  config: EmailAccountConfig;
  password: string;
}

interface ResolvedEmailRuntimeConfig {
  accounts: ResolvedEmailAccount[];
}

interface EmailAccountState {
  account: ResolvedEmailAccount;
  connectionManager: ReturnType<typeof createEmailConnectionManager> | null;
  transport: Transporter | null;
  threadTracker: ReturnType<typeof createThreadTracker>;
}

export type EmailReplyFn = (
  content: string,
  options?: EmailTextSendOptions,
) => Promise<void>;

export interface EmailMessageContext {
  accountAddress: string;
  agentId: string;
  abortSignal: AbortSignal;
  folder: string;
  uid: number;
  senderAddress: string;
  senderName: string;
  sendAttachment: (
    params: Omit<EmailAttachmentSendParams, 'to'>,
  ) => Promise<void>;
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
  agentId?: string | null;
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
  fromName?: string | null;
}

export interface EmailTextSendOptions {
  agentId?: string | null;
  subject?: string | null;
  cc?: string[] | null;
  bcc?: string[] | null;
  inReplyTo?: string | null;
  references?: string[] | null;
  metadata?: EmailDeliveryMetadata | null;
  fromName?: string | null;
}

function createEmailShutdownAbortError(): Error {
  return new Error('Email runtime shutting down.');
}

async function appendSentCopiesToImap(
  config: EmailAppendSentConfig,
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

function accountKey(address: string): string {
  return String(address || '')
    .trim()
    .toLowerCase();
}

function normalizeEmailAgentId(value: string): string {
  return String(value || '').trim() || DEFAULT_AGENT_ID;
}

function accountFromLegacyConfig(
  config: RuntimeEmailConfig,
): ResolvedEmailAccount | null {
  const address = config.address.trim();
  const password = String(EMAIL_PASSWORD || config.password || '').trim();
  if (!address && !config.imapHost.trim() && !config.smtpHost.trim()) {
    return null;
  }
  if (!address) {
    throw new Error('Email channel address is not configured.');
  }
  if (!config.imapHost.trim()) {
    throw new Error('Email IMAP host is not configured.');
  }
  if (!config.smtpHost.trim()) {
    throw new Error('Email SMTP host is not configured.');
  }
  if (!password) {
    throw new Error(
      'Email channel password is required. Store EMAIL_PASSWORD with `hybridclaw secret set EMAIL_PASSWORD <password>` or in TUI with `/secret set EMAIL_PASSWORD <password>`, or set email.password in /admin/config.',
    );
  }
  const accountConfig: EmailAccountConfig = {
    agentId: DEFAULT_AGENT_ID,
    imapHost: config.imapHost,
    imapPort: config.imapPort,
    imapSecure: config.imapSecure,
    smtpHost: config.smtpHost,
    smtpPort: config.smtpPort,
    smtpSecure: config.smtpSecure,
    address,
    password,
    pollIntervalMs: config.pollIntervalMs,
    folders: [...config.folders],
    allowFrom: [...config.allowFrom],
    mediaMaxMb: config.mediaMaxMb,
  };
  return {
    key: accountKey(address),
    agentId: DEFAULT_AGENT_ID,
    address,
    config: accountConfig,
    password,
  };
}

function accountFromAccountConfig(
  account: RuntimeEmailAccountConfig,
  index: number,
): ResolvedEmailAccount {
  const address = account.address.trim();
  const agentId = normalizeEmailAgentId(account.agentId);
  const password = String(account.password || '').trim();
  const label = address || `email.accounts[${index}]`;
  if (!address) {
    throw new Error(`Email account ${index + 1} address is not configured.`);
  }
  if (!account.imapHost.trim()) {
    throw new Error(`Email account ${label} IMAP host is not configured.`);
  }
  if (!account.smtpHost.trim()) {
    throw new Error(`Email account ${label} SMTP host is not configured.`);
  }
  if (!password) {
    throw new Error(`Email account ${label} password is not configured.`);
  }
  return {
    key: accountKey(address),
    agentId,
    address,
    config: {
      ...account,
      agentId,
      address,
      password,
      folders: [...account.folders],
      allowFrom: [...account.allowFrom],
    },
    password,
  };
}

function configuredAccountOverridesLegacy(
  account: ResolvedEmailAccount,
  legacy: ResolvedEmailAccount,
): boolean {
  return account.agentId === DEFAULT_AGENT_ID || account.key === legacy.key;
}

function resolveRuntimeConfig(): ResolvedEmailRuntimeConfig {
  const config = getConfigSnapshot().email;
  if (!config.enabled) {
    throw new Error('Email channel is not enabled.');
  }

  const configuredAccounts = config.accounts.map(accountFromAccountConfig);
  const legacyAccount =
    configuredAccounts.length > 0 && !config.address.trim()
      ? null
      : accountFromLegacyConfig(config);
  const accounts = [...configuredAccounts];
  if (
    legacyAccount &&
    !configuredAccounts.some((account) =>
      configuredAccountOverridesLegacy(account, legacyAccount),
    )
  ) {
    accounts.unshift(legacyAccount);
  }
  if (accounts.length === 0) {
    throw new Error('Email channel has no configured accounts.');
  }

  const seen = new Set<string>();
  for (const account of accounts) {
    if (seen.has(account.key)) {
      throw new Error(
        `Email account address is configured more than once: ${account.address}`,
      );
    }
    seen.add(account.key);
  }

  return {
    accounts,
  };
}

export function createEmailRuntime() {
  type ResolvedRuntimeConfig = ReturnType<typeof resolveRuntimeConfig>;

  let shuttingDown = false;
  let runtimeConfig: ResolvedRuntimeConfig | null = null;
  const accountStates = new Map<string, EmailAccountState>();
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

  const ensureAccountStates = (): EmailAccountState[] => {
    ensureRuntimeActive();
    if (accountStates.size > 0) return [...accountStates.values()];
    for (const account of ensureRuntimeConfig().accounts) {
      accountStates.set(account.key, {
        account,
        connectionManager: null,
        transport: null,
        threadTracker: createThreadTracker(),
      });
    }
    return [...accountStates.values()];
  };

  const abortInFlightHandlers = (): void => {
    for (const controller of inFlightControllers) {
      if (controller.signal.aborted) continue;
      controller.abort(createEmailShutdownAbortError());
    }
  };

  const resolveSendAccountState = (
    agentId?: string | null,
  ): EmailAccountState => {
    ensureRuntimeActive();
    const states = ensureAccountStates();
    const normalizedAgentId = String(agentId || '').trim();
    if (normalizedAgentId) {
      const matching = states.find(
        (state) => state.account.agentId === normalizedAgentId,
      );
      if (matching) return matching;
    }
    const first = states[0];
    if (!first) {
      throw new Error('Email channel has no configured accounts.');
    }
    return first;
  };

  const ensureTransport = async (
    state: EmailAccountState,
  ): Promise<Transporter> => {
    ensureRuntimeActive();
    if (state.transport) return state.transport;

    const { account } = state;
    state.transport = nodemailer.createTransport({
      pool: true,
      host: account.config.smtpHost,
      port: account.config.smtpPort,
      secure: account.config.smtpSecure,
      auth: {
        user: account.address,
        pass: account.password,
      },
    });
    await state.transport.verify();
    return state.transport;
  };

  const sendWithTracking = async (
    state: EmailAccountState,
    params: Omit<
      EmailSendParams,
      'selfAddress' | 'threadContext' | 'transport'
    >,
  ): Promise<void> => {
    ensureRuntimeActive();
    const transport = await ensureTransport(state);
    const { account, threadTracker } = state;
    const result = await sendEmail({
      ...params,
      transport,
      selfAddress: account.address,
      threadContext: threadTracker.get(params.to),
    });
    await appendSentCopiesToImap(
      account.config,
      account.password,
      result.sentCopies,
    ).catch((error) => {
      logger.warn(
        {
          error,
          from: account.address,
          to: params.to,
          sentCopyCount: result.sentCopies.length,
        },
        'Failed to append sent email copy to IMAP Sent folder',
      );
    });
    if (result.threadContext) {
      threadTracker.remember(params.to, result.threadContext);
    }
  };

  const sendTextFromAccount = async (
    state: EmailAccountState,
    to: string,
    text: string,
    options?: EmailTextSendOptions,
  ): Promise<void> => {
    await sendWithTracking(state, {
      to,
      body: text,
      subject: options?.subject,
      cc: options?.cc,
      bcc: options?.bcc,
      inReplyTo: options?.inReplyTo,
      references: options?.references,
      metadata: options?.metadata,
      fromName: options?.fromName,
    });
  };

  const sendAttachmentFromAccount = async (
    state: EmailAccountState,
    params: EmailAttachmentSendParams,
  ): Promise<void> => {
    await sendWithTracking(state, {
      to: params.to,
      body: params.body || '',
      subject: params.subject,
      cc: params.cc,
      bcc: params.bcc,
      inReplyTo: params.inReplyTo,
      references: params.references,
      metadata: params.metadata,
      fromName: params.fromName,
      attachment: {
        filePath: params.filePath,
        filename: params.filename || null,
        mimeType: params.mimeType || null,
      },
    });
  };

  const sendTextToAddress = async (
    to: string,
    text: string,
    options?: EmailTextSendOptions,
  ): Promise<void> => {
    await sendTextFromAccount(
      resolveSendAccountState(options?.agentId),
      to,
      text,
      options,
    );
  };

  const sendAttachmentToAddress = async (
    params: EmailAttachmentSendParams,
  ): Promise<void> => {
    await sendAttachmentFromAccount(
      resolveSendAccountState(params.agentId),
      params,
    );
  };

  const ensureConnectionManagers = (
    messageHandler?: EmailMessageHandler,
  ): EmailAccountState[] => {
    const states = ensureAccountStates();
    for (const state of states) {
      if (state.connectionManager) continue;
      const { account, threadTracker } = state;
      state.connectionManager = createEmailConnectionManager(
        account.config,
        account.password,
        async (messages) => {
          if (!messageHandler || shuttingDown) return;
          for (const message of messages) {
            if (shuttingDown) break;
            const inbound = await processInboundEmail(
              message.raw,
              account.config,
              account.address,
              account.agentId,
            );
            if (!inbound) continue;

            if (inbound.threadContext) {
              threadTracker.remember(
                inbound.senderAddress,
                inbound.threadContext,
              );
            }

            const controller = new AbortController();
            inFlightControllers.add(controller);
            if (shuttingDown && !controller.signal.aborted) {
              controller.abort(createEmailShutdownAbortError());
            }
            const reply: EmailReplyFn = async (content, options) => {
              if (controller.signal.aborted) {
                const reason = controller.signal.reason;
                throw reason instanceof Error
                  ? reason
                  : createEmailShutdownAbortError();
              }
              await sendTextFromAccount(
                state,
                inbound.channelId,
                content,
                options,
              );
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
                  accountAddress: account.address,
                  agentId: inbound.agentId,
                  abortSignal: controller.signal,
                  folder: message.folder,
                  uid: message.uid,
                  senderAddress: inbound.senderAddress,
                  senderName: inbound.senderName,
                  sendAttachment: async (params) => {
                    await sendAttachmentFromAccount(state, {
                      to: inbound.channelId,
                      ...params,
                    });
                  },
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
    }
    return states;
  };
  const runtimeLifecycle = createChannelRuntime<EmailMessageHandler>()({
    kind: 'email',
    capabilities: EMAIL_CAPABILITIES,
    resolveConfig: () => {
      ensureRuntimeActive();
      return ensureRuntimeConfig();
    },
    resolveRegistration: (config) =>
      config.accounts.map((account) => account.address).join(','),
    start: async (params: {
      config: ResolvedRuntimeConfig;
      handler: EmailMessageHandler;
    }) => {
      const states = ensureConnectionManagers(params.handler);
      await Promise.all(states.map((state) => ensureTransport(state)));
      await Promise.all(
        states.map((state) => state.connectionManager?.start()),
      );
    },
    cleanup: async () => {
      shuttingDown = true;
      abortInFlightHandlers();
      const states = [...accountStates.values()];
      await Promise.all(states.map((state) => state.connectionManager?.stop()));
      await Promise.all(states.map((state) => state.transport?.close()));
      for (const state of states) {
        state.threadTracker.clear();
      }
      accountStates.clear();
      runtimeConfig = null;
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
