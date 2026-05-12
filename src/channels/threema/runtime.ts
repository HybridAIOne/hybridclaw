import {
  getConfigSnapshot,
  THREEMA_GATEWAY_SECRET,
} from '../../config/config.js';
import { THREEMA_CAPABILITIES } from '../channel.js';
import { registerChannel, unregisterChannel } from '../channel-registry.js';
import { sendChunkedThreemaText } from './delivery.js';

let runtimeInitialized = false;
let shutdownController: AbortController | null = null;

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

export function initThreema(): Promise<void> {
  if (runtimeInitialized) return Promise.resolve();

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
  shutdownController = new AbortController();
  runtimeInitialized = true;
  return Promise.resolve();
}

export async function sendToThreemaChat(
  target: string,
  text: string,
): Promise<void> {
  await sendChunkedThreemaText({
    signal: shutdownController?.signal,
    target,
    text,
  });
}

export function shutdownThreema(): Promise<void> {
  shutdownController?.abort();
  shutdownController = null;
  unregisterChannel('threema');
  runtimeInitialized = false;
  return Promise.resolve();
}
