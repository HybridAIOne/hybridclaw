import { LINE_STORAGE_KEYS } from './auth.js';
import {
  buildLineChannelId,
  normalizeLineChannelId,
  normalizeLineUserMid,
} from './target.js';

/**
 * @typedef {import('@hybridaione/hybridclaw/plugin-sdk').ChannelTransportHost} ChannelTransportHost
 * @typedef {ReturnType<typeof import('./auth.js').createLineAuthStore>} LineAuthStore
 * @typedef {ReturnType<typeof import('./pairing-state.js').createLinePairingState>} LinePairingState
 * @typedef {ReturnType<typeof createLineHost>} LineTransportHost
 */

/**
 * Extends the core transport host with the plugin-owned credential store,
 * pairing prompt, and target helpers the LINE transport modules use.
 *
 * @param {ChannelTransportHost} host
 * @param {LineAuthStore} store
 * @param {LinePairingState} pairing
 */
export function createLineHost(host, store, pairing) {
  return {
    ...host,
    auth: {
      storageKeys: LINE_STORAGE_KEYS,
      acquireLock: () => store.acquireLock(),
      ensureStoragePath: () => store.ensureStoragePath(),
    },
    pairing: {
      clear: () => pairing.clear(),
      /** @param {string} error */
      setError: (error) => pairing.setError(error),
      /** @param {string} pincode */
      setPincode: (pincode) => pairing.setPincode(pincode),
      /** @param {{ text: string; url: string }} params */
      setQr: ({ text, url }) =>
        pairing.setQr({
          text,
          url,
          svg: host.renderQrSvg(url, 'LINE pairing QR'),
        }),
    },
    target: {
      normalizeUserMid: normalizeLineUserMid,
      buildChannelId: buildLineChannelId,
      normalizeChannelId: normalizeLineChannelId,
    },
  };
}
