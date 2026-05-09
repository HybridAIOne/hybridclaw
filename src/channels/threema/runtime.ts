import {
  getConfigSnapshot,
  THREEMA_GATEWAY_SECRET,
} from '../../config/config.js';
import { THREEMA_CAPABILITIES } from '../channel.js';
import { registerChannel, unregisterChannel } from '../channel-registry.js';
import { sendChunkedThreemaText } from './delivery.js';

export type ThreemaReplyFn = (content: string) => Promise<void>;

export interface ThreemaMessageContext {
  abortSignal: AbortSignal;
}

export type ThreemaMessageHandler = (
  sessionId: string,
  guildId: string | null,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  reply: ThreemaReplyFn,
  context: ThreemaMessageContext,
) => Promise<void>;

let runtimeInitialized = false;

function resolveThreemaConfig() {
  return getConfigSnapshot().threema;
}

export function hasThreemaGatewaySecret(): boolean {
  return Boolean(
    String(
      THREEMA_GATEWAY_SECRET || resolveThreemaConfig().secret || '',
    ).trim(),
  );
}

export async function initThreema(
  _messageHandler?: ThreemaMessageHandler,
): Promise<void> {
  if (runtimeInitialized) return;

  const config = resolveThreemaConfig();
  if (!config.enabled) {
    throw new Error('Threema integration disabled: threema.enabled=false.');
  }
  if (!String(config.identity || '').trim()) {
    throw new Error('Threema Gateway identity is not configured.');
  }
  if (!hasThreemaGatewaySecret()) {
    throw new Error('Threema Gateway secret is not configured.');
  }

  registerChannel({
    kind: 'threema',
    id: config.identity,
    capabilities: THREEMA_CAPABILITIES,
  });
  runtimeInitialized = true;
}

export async function sendToThreemaChat(
  target: string,
  text: string,
): Promise<void> {
  await sendChunkedThreemaText({ target, text });
}

export async function shutdownThreema(): Promise<void> {
  unregisterChannel('threema');
  runtimeInitialized = false;
}
