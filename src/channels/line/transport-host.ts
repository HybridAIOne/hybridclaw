import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { getConfigSnapshot } from '../../config/config.js';
import type { RuntimeLineConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import type { PluginLogger } from '../../plugins/plugin-types.js';
import { buildSessionKey } from '../../session/session-key.js';
import { normalizeNativeAgentAddressingText } from '../agent-addressing.js';
import {
  acquireLineAuthLock,
  ensureLineAuthStoragePath,
  LINE_AUTH_DIR,
  LINE_AUTH_STORAGE_KEY,
  LINE_PROFILE_MID_STORAGE_KEY,
  LINE_SYNC_STORAGE_KEY,
} from './auth.js';
import {
  clearLinePairingState,
  setLinePairingError,
  setLinePairingPincode,
  setLinePairingQr,
} from './pairing-state.js';
import {
  buildLineChannelId,
  normalizeLineChannelId,
  normalizeLineUserMid,
} from './target.js';

export interface LineTransportHost {
  defaultAgentId: string;
  logger: PluginLogger;
  getConfig(): RuntimeLineConfig;
  auth: {
    authDir: string;
    storageKeys: {
      authToken: string;
      profileMid: string;
      sync: string;
    };
    acquireLock: typeof acquireLineAuthLock;
    ensureStoragePath: typeof ensureLineAuthStoragePath;
  };
  pairing: {
    clear: typeof clearLinePairingState;
    setError: typeof setLinePairingError;
    setPincode: typeof setLinePairingPincode;
    setQr: typeof setLinePairingQr;
  };
  target: {
    normalizeUserMid: typeof normalizeLineUserMid;
    buildChannelId: typeof buildLineChannelId;
    normalizeChannelId: typeof normalizeLineChannelId;
  };
  text: {
    normalizeNativeAgentAddressingText: typeof normalizeNativeAgentAddressingText;
  };
  buildSessionKey: typeof buildSessionKey;
}

export function createLineTransportHost(): LineTransportHost {
  return {
    defaultAgentId: DEFAULT_AGENT_ID,
    logger: logger as PluginLogger,
    getConfig: () => getConfigSnapshot().line,
    auth: {
      authDir: LINE_AUTH_DIR,
      storageKeys: {
        authToken: LINE_AUTH_STORAGE_KEY,
        profileMid: LINE_PROFILE_MID_STORAGE_KEY,
        sync: LINE_SYNC_STORAGE_KEY,
      },
      acquireLock: acquireLineAuthLock,
      ensureStoragePath: ensureLineAuthStoragePath,
    },
    pairing: {
      clear: clearLinePairingState,
      setError: setLinePairingError,
      setPincode: setLinePairingPincode,
      setQr: setLinePairingQr,
    },
    target: {
      normalizeUserMid: normalizeLineUserMid,
      buildChannelId: buildLineChannelId,
      normalizeChannelId: normalizeLineChannelId,
    },
    text: {
      normalizeNativeAgentAddressingText,
    },
    buildSessionKey,
  };
}
