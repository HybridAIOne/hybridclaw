import type { IMessageBackend } from '../../config/runtime-config.js';
import type { MediaContextItem } from '../../types/container.js';

export type IMessageReplyFn = (content: string) => Promise<void>;

export interface IMessageInbound {
  sessionId: string;
  guildId: string | null;
  channelId: string;
  userId: string;
  username: string;
  content: string;
  media: MediaContextItem[];
  messageId: string | null;
  conversationId: string;
  handle: string;
  isGroup: boolean;
  backend: IMessageBackend;
  rawEvent: unknown;
}

export interface IMessageMessageContext {
  abortSignal: AbortSignal;
  inbound: IMessageInbound;
  rawEvent: unknown;
  backend: IMessageBackend;
  conversationId: string;
  handle: string;
  isGroup: boolean;
}

export type IMessageMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  media: MediaContextItem[],
  reply: IMessageReplyFn,
  context: IMessageMessageContext,
) => Promise<void>;
