import type {
  ChannelTransportInstance,
  HybridClawPluginDefinition,
  WhatsAppTransportHost,
} from '@hybridaione/hybridclaw/plugin-sdk';

function createLazyTransport(
  host: WhatsAppTransportHost,
): ChannelTransportInstance {
  let transportPromise: Promise<ChannelTransportInstance> | null = null;
  const getTransport = (): Promise<ChannelTransportInstance> => {
    transportPromise ??= import('./transport.js').then((module) =>
      module.createWhatsAppTransport(host),
    );
    return transportPromise;
  };

  return {
    async init(handler) {
      await (await getTransport()).init(handler);
    },
    async shutdown() {
      if (!transportPromise) return;
      await (await transportPromise).shutdown();
    },
    async sendText(chatId, text) {
      await (await getTransport()).sendText(chatId, text);
    },
    async sendMedia(params) {
      await (await getTransport()).sendMedia(params);
    },
    async createPairingSession() {
      const transport = await getTransport();
      if (!transport.createPairingSession) {
        throw new Error('WhatsApp transport does not support pairing.');
      }
      return transport.createPairingSession();
    },
  };
}

const plugin: HybridClawPluginDefinition = {
  id: 'whatsapp',
  name: 'WhatsApp',
  version: '0.1.0',
  kind: 'channel',
  register(api) {
    api.registerChannelTransport({
      kind: 'whatsapp',
      create: createLazyTransport,
    });
  },
};

export default plugin;
