import type { MediaContextItem } from '../types/container.js';
import type { ChannelKind } from './channel.js';
import type { WhatsAppTransportHost } from './whatsapp/transport-host.js';

export type ChannelTransportReplyFn = (content: string) => Promise<void>;

export interface ChannelTransportMessageContext {
  abortSignal: AbortSignal;
  batchedMessages: unknown[];
  rawMessage: unknown;
  chatJid: string;
  senderJid: string;
  isGroup: boolean;
}

export type ChannelTransportMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: ChannelTransportReplyFn,
  context: ChannelTransportMessageContext,
) => Promise<void>;

export interface ChannelTransportMediaSendParams {
  jid: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}

export interface ChannelTransportPairingSession {
  start(): Promise<void>;
  waitForConnection(): Promise<{ id: string | null }>;
  stop(): Promise<void>;
}

export interface ChannelTransportInstance {
  init(handler: ChannelTransportMessageHandler): Promise<void>;
  shutdown(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendMedia(params: ChannelTransportMediaSendParams): Promise<void>;
  createPairingSession?(): Promise<ChannelTransportPairingSession>;
}

export interface WhatsAppChannelTransportRegistration {
  kind: 'whatsapp';
  create(host: WhatsAppTransportHost): ChannelTransportInstance;
}

export type ChannelTransportRegistration = WhatsAppChannelTransportRegistration;

const transports = new Map<ChannelKind, ChannelTransportRegistration>();

export function registerChannelTransport(
  registration: ChannelTransportRegistration,
): void {
  if (transports.has(registration.kind)) {
    throw new Error(
      `Channel transport "${registration.kind}" is already registered.`,
    );
  }
  transports.set(registration.kind, registration);
}

export function unregisterChannelTransport(kind: ChannelKind): void {
  transports.delete(kind);
}

export function hasChannelTransport(kind: ChannelKind): boolean {
  return transports.has(kind);
}

export function getChannelTransport(
  kind: 'whatsapp',
): WhatsAppChannelTransportRegistration | undefined;
export function getChannelTransport(
  kind: ChannelKind,
): ChannelTransportRegistration | undefined;
export function getChannelTransport(
  kind: ChannelKind,
): ChannelTransportRegistration | undefined {
  return transports.get(kind);
}
