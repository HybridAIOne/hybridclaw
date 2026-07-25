import { LINE_CAPABILITIES } from '../channel.js';
import { getChannelPluginInstallCommand } from '../channel-plugin-catalog.js';
import { registerChannel } from '../channel-registry.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import {
  type ChannelTransportInstance,
  type ChannelTransportMessageContext,
  type ChannelTransportMessageHandler,
  type ChannelTransportPairingSession,
  type ChannelTransportReplyFn,
  getChannelTransport,
  hasChannelTransport,
} from '../channel-transport.js';

export const LINE_PLUGIN_INSTALL_COMMAND =
  getChannelPluginInstallCommand('line');
export const LINE_PLUGIN_INSTALL_HINT = `Install it with: ${LINE_PLUGIN_INSTALL_COMMAND}`;

export class LineTransportMissingError extends Error {
  constructor() {
    super(
      `LINE transport plugin is not installed. ${LINE_PLUGIN_INSTALL_HINT}`,
    );
    this.name = 'LineTransportMissingError';
  }
}

export type LineReplyFn = ChannelTransportReplyFn;
export interface LineMessageContext extends ChannelTransportMessageContext {}
export type LineMessageHandler = ChannelTransportMessageHandler;

let transportInstance: ChannelTransportInstance | null = null;
let transportCreation: Promise<ChannelTransportInstance> | null = null;

function createMissingTransportError(): LineTransportMissingError {
  return new LineTransportMissingError();
}

async function ensureTransportInstance(): Promise<ChannelTransportInstance> {
  if (transportInstance) return transportInstance;
  const registration = getChannelTransport('line');
  if (!registration) throw createMissingTransportError();
  transportCreation ??= import('./transport-host.js')
    .then(({ createLineTransportHost }) => {
      transportInstance = registration.create(createLineTransportHost());
      return transportInstance;
    })
    .finally(() => {
      transportCreation = null;
    });
  return transportCreation;
}

const runtimeLifecycle = createChannelRuntime<LineMessageHandler>()({
  kind: 'line',
  capabilities: LINE_CAPABILITIES,
  start: async ({ handler }) => {
    const wrappedHandler: LineMessageHandler = (
      sessionId,
      guildId,
      channelId,
      userId,
      username,
      content,
      media,
      reply,
      context,
    ) => {
      registerChannel({
        kind: 'line',
        id: channelId,
        capabilities: LINE_CAPABILITIES,
      });
      return handler(
        sessionId,
        guildId,
        channelId,
        userId,
        username,
        content,
        media,
        reply,
        context,
      );
    };
    const instance = await ensureTransportInstance();
    try {
      await instance.init(wrappedHandler);
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

export function isLineTransportInstalled(): boolean {
  return hasChannelTransport('line');
}

export const initLine = (messageHandler: LineMessageHandler): Promise<void> => {
  if (!isLineTransportInstalled()) {
    return Promise.reject(createMissingTransportError());
  }
  return runtimeLifecycle.init(messageHandler);
};

export async function sendToLineSelfChat(
  channelId: string,
  text: string,
): Promise<void> {
  await (await ensureTransportInstance()).sendText(channelId, text);
}

export async function createLinePairingSession(): Promise<ChannelTransportPairingSession> {
  const instance = await ensureTransportInstance();
  if (!instance.createPairingSession) {
    throw new Error('LINE transport plugin does not support pairing.');
  }
  return instance.createPairingSession();
}

export async function shutdownLine(): Promise<void> {
  await runtimeLifecycle.shutdown();
}
