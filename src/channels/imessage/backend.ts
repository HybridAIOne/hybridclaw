import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IMessageOutboundMessageRef } from './self-echo-cache.js';
import type { IMessageInbound } from './types.js';

export interface IMessageMediaSendParams {
  target: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
}

export interface IMessageBackendInstance {
  start(): Promise<void>;
  sendText(target: string, text: string): Promise<IMessageOutboundMessageRef[]>;
  sendMedia(
    params: IMessageMediaSendParams,
  ): Promise<IMessageOutboundMessageRef | null>;
  handleWebhook?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  shutdown(): Promise<void>;
}

export interface IMessageBackendFactoryParams {
  onInbound: (message: IMessageInbound) => Promise<void>;
}
