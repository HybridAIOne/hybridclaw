import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { APP_VERSION, getConfigSnapshot } from '../../config/config.js';
import type { RuntimeWhatsAppConfig } from '../../config/runtime-config.js';
import { logger } from '../../logger.js';
import { resolveManagedTempMediaDir } from '../../media/managed-temp-media.js';
import { normalizeMimeType } from '../../media/mime-utils.js';
import { createUploadedMediaContextItem } from '../../media/uploaded-media-cache.js';
import { chunkMessage } from '../../memory/chunk.js';
import type { PluginLogger } from '../../plugins/plugin-types.js';
import { buildSessionKey } from '../../session/session-key.js';
import { SlidingWindowRateLimiter } from '../../utils/rate-limiter.js';
import { sleep } from '../../utils/sleep.js';
import {
  describeExpectedTransportError,
  isExpectedTransportError,
} from '../../utils/transport-errors.js';
import { normalizeNativeAgentAddressingText } from '../agent-addressing.js';
import {
  acquireWhatsAppAuthLock,
  ensureWhatsAppAuthDir,
  WHATSAPP_AUTH_DIR,
} from './auth.js';
import {
  clearWhatsAppPairingState,
  setWhatsAppPairingError,
  setWhatsAppPairingQrText,
} from './pairing-state.js';
import {
  canonicalizeWhatsAppUserJid,
  isGroupJid,
  jidToPhone,
  normalizePhoneNumber,
  normalizeWhatsAppUserIdentity,
} from './phone.js';

export interface WhatsAppTransportHost {
  appVersion: string;
  defaultAgentId: string;
  logger: PluginLogger;
  getConfig(): RuntimeWhatsAppConfig;
  auth: {
    authDir: string;
    acquireLock: typeof acquireWhatsAppAuthLock;
    ensureAuthDir: typeof ensureWhatsAppAuthDir;
  };
  pairing: {
    clear: typeof clearWhatsAppPairingState;
    setError: typeof setWhatsAppPairingError;
    setQrText: typeof setWhatsAppPairingQrText;
  };
  phone: {
    canonicalizeUserJid: typeof canonicalizeWhatsAppUserJid;
    isGroupJid: typeof isGroupJid;
    jidToPhone: typeof jidToPhone;
    normalizePhoneNumber: typeof normalizePhoneNumber;
    normalizeUserIdentity: typeof normalizeWhatsAppUserIdentity;
  };
  media: {
    createContextItem: typeof createUploadedMediaContextItem;
    normalizeMimeType: typeof normalizeMimeType;
    resolveManagedTempDir: typeof resolveManagedTempMediaDir;
  };
  text: {
    chunkMessage: typeof chunkMessage;
    normalizeNativeAgentAddressingText: typeof normalizeNativeAgentAddressingText;
  };
  buildSessionKey: typeof buildSessionKey;
  describeExpectedTransportError: typeof describeExpectedTransportError;
  isExpectedTransportError: typeof isExpectedTransportError;
  SlidingWindowRateLimiter: typeof SlidingWindowRateLimiter;
  sleep: typeof sleep;
}

export function createWhatsAppTransportHost(): WhatsAppTransportHost {
  return {
    appVersion: APP_VERSION,
    defaultAgentId: DEFAULT_AGENT_ID,
    logger: logger as PluginLogger,
    getConfig: () => getConfigSnapshot().whatsapp,
    auth: {
      authDir: WHATSAPP_AUTH_DIR,
      acquireLock: acquireWhatsAppAuthLock,
      ensureAuthDir: ensureWhatsAppAuthDir,
    },
    pairing: {
      clear: clearWhatsAppPairingState,
      setError: setWhatsAppPairingError,
      setQrText: setWhatsAppPairingQrText,
    },
    phone: {
      canonicalizeUserJid: canonicalizeWhatsAppUserJid,
      isGroupJid,
      jidToPhone,
      normalizePhoneNumber,
      normalizeUserIdentity: normalizeWhatsAppUserIdentity,
    },
    media: {
      createContextItem: createUploadedMediaContextItem,
      normalizeMimeType,
      resolveManagedTempDir: resolveManagedTempMediaDir,
    },
    text: {
      chunkMessage,
      normalizeNativeAgentAddressingText,
    },
    buildSessionKey,
    describeExpectedTransportError,
    isExpectedTransportError,
    SlidingWindowRateLimiter,
    sleep,
  };
}
