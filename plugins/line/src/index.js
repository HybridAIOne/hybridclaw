import path from 'node:path';
import { createLineAuthStore } from './auth.js';
import { createLineHost } from './host.js';
import { createLinePairingState } from './pairing-state.js';
import { isLineChannelId, normalizeLineMessageTarget } from './target.js';

/**
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').ChannelTransportInstance} ChannelTransportInstance
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').HybridClawPluginDefinition} HybridClawPluginDefinition
 * @typedef {import('./host.js').LineTransportHost} LineTransportHost
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

// A plugin reload re-registers while core keeps the live transport, whose
// pairing prompt the console must still see, so the state is per process.
const PAIRING_STATE_KEY = Symbol.for('hybridclaw.line.pairingState');

/** @type {HybridClawPluginDefinition} */
const plugin = {
  id: 'line',
  name: 'LINE',
  version: '0.2.0',
  kind: 'channel',
  register(api) {
    const store = createLineAuthStore(
      path.join(api.runtime.homeDir, 'credentials', 'line'),
    );
    globalThis[PAIRING_STATE_KEY] ??= createLinePairingState();
    const pairing = globalThis[PAIRING_STATE_KEY];
    api.registerChannelTransport({
      kind: 'line',
      create: (host) =>
        createLazyTransport(createLineHost(host, store, pairing)),
      matchesTarget: isLineChannelId,
      normalizeTarget: normalizeLineMessageTarget,
      getAuthStatus: () => store.getStatus(),
      resetAuth: () => store.reset(),
      getPairingState: () => pairing.get(),
      async doctorChecks({ enabled }) {
        if (!enabled) return [];
        const { linked } = await store.getStatus();
        return [
          linked
            ? { severity: 'ok', message: 'LINE linked' }
            : {
                severity: 'warn',
                message:
                  'LINE not linked (run `hybridclaw channels line setup`)',
              },
        ];
      },
      messageToolHints: ({ channelId }) => [
        ...(channelId
          ? [
              `- Current LINE self-chat: \`${channelId}\`. Normal assistant replies return here automatically.`,
            ]
          : []),
        '- LINE is configured for the linked account self-chat only; do not attempt to address other LINE users or groups.',
        '- Keep LINE replies concise and avoid platform-specific mention syntax.',
      ],
    });
  },
};

export default plugin;
