/**
 * Plugin channel runtime — owns at most one live transport instance per
 * catalog kind and preserves the transport's send results.
 *
 * Every operation resolves the registration through `requireChannelTransport`,
 * so an unknown kind or a missing plugin throws instead of reaching another
 * channel. NOT the gateway integration (`gateway.ts` wires inbound turns) and
 * not a delivery receipt: a send result only carries transport message IDs.
 */
import {
  getPluginChannelName,
  type PluginChannelKind,
} from '../channel-plugin-catalog.js';
import { getChannelCapabilities } from '../channel-registry.js';
import { createChannelRuntime } from '../channel-runtime-factory.js';
import {
  type ChannelTransportInstance,
  type ChannelTransportMediaSendParams,
  type ChannelTransportMessageHandler,
  type ChannelTransportPairingSession,
  type ChannelTransportSendResult,
  requireChannelTransport,
} from '../channel-transport.js';

interface PluginChannelRuntime {
  instance: ChannelTransportInstance | null;
  creation: Promise<ChannelTransportInstance> | null;
  lifecycle: {
    init(handler: ChannelTransportMessageHandler): Promise<void>;
    shutdown(): Promise<void>;
  };
}

const runtimes = new Map<PluginChannelKind, PluginChannelRuntime>();

async function ensureInstance(
  kind: PluginChannelKind,
  runtime: PluginChannelRuntime,
): Promise<ChannelTransportInstance> {
  if (runtime.instance) return runtime.instance;
  const registration = requireChannelTransport(kind);
  runtime.creation ??= import('./host.js')
    .then(({ createChannelTransportHost }) => {
      runtime.instance = registration.create(createChannelTransportHost(kind));
      return runtime.instance;
    })
    .finally(() => {
      runtime.creation = null;
    });
  return runtime.creation;
}

function getRuntime(kind: PluginChannelKind): PluginChannelRuntime {
  const existing = runtimes.get(kind);
  if (existing) return existing;
  const runtime: PluginChannelRuntime = {
    instance: null,
    creation: null,
    lifecycle: createChannelRuntime<ChannelTransportMessageHandler>()({
      kind,
      capabilities: getChannelCapabilities(kind),
      start: async ({ handler }) => {
        const instance = await ensureInstance(kind, runtime);
        try {
          await instance.init(handler);
        } catch (error) {
          runtime.instance = null;
          runtime.creation = null;
          await instance.shutdown().catch(() => undefined);
          throw error;
        }
      },
      cleanup: async () => {
        const instance =
          runtime.instance ??
          (await runtime.creation?.catch(() => null)) ??
          null;
        runtime.instance = null;
        runtime.creation = null;
        await instance?.shutdown();
      },
    }),
  };
  runtimes.set(kind, runtime);
  return runtime;
}

export async function initPluginChannel(
  kind: PluginChannelKind,
  handler: ChannelTransportMessageHandler,
): Promise<void> {
  requireChannelTransport(kind);
  await getRuntime(kind).lifecycle.init(handler);
}

export async function sendPluginChannelText(
  kind: PluginChannelKind,
  chatId: string,
  text: string,
): Promise<ChannelTransportSendResult | undefined> {
  const instance = await ensureInstance(kind, getRuntime(kind));
  return (await instance.sendText(chatId, text)) ?? undefined;
}

export async function sendPluginChannelMedia(
  kind: PluginChannelKind,
  params: ChannelTransportMediaSendParams,
): Promise<ChannelTransportSendResult | undefined> {
  const instance = await ensureInstance(kind, getRuntime(kind));
  return (await instance.sendMedia(params)) ?? undefined;
}

export async function createPluginChannelPairingSession(
  kind: PluginChannelKind,
): Promise<ChannelTransportPairingSession> {
  const instance = await ensureInstance(kind, getRuntime(kind));
  if (!instance.createPairingSession) {
    throw new Error(
      `${getPluginChannelName(kind)} transport plugin does not support pairing.`,
    );
  }
  return instance.createPairingSession();
}

export async function shutdownPluginChannel(
  kind: PluginChannelKind,
): Promise<void> {
  await runtimes.get(kind)?.lifecycle.shutdown();
}
