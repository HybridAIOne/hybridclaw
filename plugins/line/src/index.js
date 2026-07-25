/**
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').ChannelTransportInstance} ChannelTransportInstance
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').HybridClawPluginDefinition} HybridClawPluginDefinition
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').LineTransportHost} LineTransportHost
 */

/**
 * Defers loading the linejs-backed transport (and its dependencies) until the
 * first transport call so plugin registration stays dependency-free.
 *
 * @param {LineTransportHost} host
 * @returns {ChannelTransportInstance}
 */
function createLazyTransport(host) {
  let transportPromise = null;
  const getTransport = () => {
    transportPromise ??= import('./transport.js').then((module) =>
      module.createLineTransport(host),
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
        throw new Error('LINE transport does not support pairing.');
      }
      return transport.createPairingSession();
    },
  };
}

/** @type {HybridClawPluginDefinition} */
const plugin = {
  id: 'line',
  name: 'LINE',
  version: '0.1.0',
  kind: 'channel',
  register(api) {
    api.registerChannelTransport({
      kind: 'line',
      create: createLazyTransport,
    });
  },
};

export default plugin;
