import { WHATSAPP_CAPABILITIES } from '../channel.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import {
  type ChannelTransportInstance,
  type ChannelTransportMediaSendParams,
  type ChannelTransportMessageContext,
  type ChannelTransportMessageHandler,
  type ChannelTransportPairingSession,
  type ChannelTransportReplyFn,
  getChannelTransport,
  hasChannelTransport,
} from '../channel-transport.js';

export const WHATSAPP_PLUGIN_INSTALL_COMMAND =
  'hybridclaw plugin install @hybridaione/hybridclaw-whatsapp';
export const WHATSAPP_PLUGIN_INSTALL_HINT = `Install it with: ${WHATSAPP_PLUGIN_INSTALL_COMMAND}`;

export class WhatsAppTransportMissingError extends Error {
  constructor() {
    super(
      `WhatsApp transport plugin is not installed. ${WHATSAPP_PLUGIN_INSTALL_HINT}`,
    );
    this.name = 'WhatsAppTransportMissingError';
  }
}

export type WhatsAppReplyFn = ChannelTransportReplyFn;
export interface WhatsAppMessageContext
  extends ChannelTransportMessageContext {}
export type WhatsAppMessageHandler = ChannelTransportMessageHandler;
export interface WhatsAppMediaSendParams
  extends ChannelTransportMediaSendParams {}

let transportInstance: ChannelTransportInstance | null = null;
let transportCreation: Promise<ChannelTransportInstance> | null = null;

function createMissingTransportError(): WhatsAppTransportMissingError {
  return new WhatsAppTransportMissingError();
}

async function ensureTransportInstance(): Promise<ChannelTransportInstance> {
  if (transportInstance) return transportInstance;
  const registration = getChannelTransport('whatsapp');
  if (!registration) throw createMissingTransportError();
  transportCreation ??= import('./transport-host.js')
    .then(({ createWhatsAppTransportHost }) => {
      transportInstance = registration.create(createWhatsAppTransportHost());
      return transportInstance;
    })
    .finally(() => {
      transportCreation = null;
    });
  return transportCreation;
}

const runtimeLifecycle = createChannelRuntime<WhatsAppMessageHandler>()({
  kind: 'whatsapp',
  capabilities: WHATSAPP_CAPABILITIES,
  start: async ({ handler }) => {
    const instance = await ensureTransportInstance();
    try {
      await instance.init(handler);
    } catch (error) {
      transportInstance = null;
      transportCreation = null;
      await instance.shutdown().catch(() => undefined);
      throw error;
    }
  },
  cleanup: async () => {
    const instance =
      transportInstance ?? (await transportCreation?.catch(() => null)) ?? null;
    transportInstance = null;
    transportCreation = null;
    await instance?.shutdown();
  },
});

export function isWhatsAppTransportInstalled(): boolean {
  return hasChannelTransport('whatsapp');
}

export const initWhatsApp = (
  messageHandler: WhatsAppMessageHandler,
): Promise<void> => {
  if (!isWhatsAppTransportInstalled()) {
    return Promise.reject(createMissingTransportError());
  }
  return runtimeLifecycle.init(messageHandler);
};

export async function sendToWhatsAppChat(
  jid: string,
  text: string,
): Promise<void> {
  await (await ensureTransportInstance()).sendText(jid, text);
}

export async function sendWhatsAppMediaToChat(
  params: WhatsAppMediaSendParams,
): Promise<void> {
  await (await ensureTransportInstance()).sendMedia(params);
}

export async function createWhatsAppPairingSession(): Promise<ChannelTransportPairingSession> {
  const instance = await ensureTransportInstance();
  if (!instance.createPairingSession) {
    throw new Error('WhatsApp transport plugin does not support pairing.');
  }
  return instance.createPairingSession();
}

export async function shutdownWhatsApp(): Promise<void> {
  await runtimeLifecycle.shutdown();
}
