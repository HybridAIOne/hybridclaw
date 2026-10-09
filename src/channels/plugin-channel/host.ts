/**
 * Builds the core-service host handed to a plugin channel transport.
 *
 * The host is the same for every kind except `getConfig`, which reads that
 * kind's live config section. Loaded lazily by the runtime so classifying a
 * target never pulls media or session helpers into the startup graph.
 */
import { DEFAULT_AGENT_ID } from '../../agents/agent-types.js';
import { APP_VERSION, getConfigSnapshot } from '../../config/config.js';
import { renderQrSvg } from '../../gateway/qr-svg.js';
import { logger } from '../../logger.js';
import { resolveManagedTempMediaDir } from '../../media/managed-temp-media.js';
import { normalizeMimeType } from '../../media/mime-utils.js';
import { createUploadedMediaContextItem } from '../../media/uploaded-media-cache.js';
import { chunkMessage } from '../../memory/chunk.js';
import { buildSessionKey } from '../../session/session-key.js';
import { SlidingWindowRateLimiter } from '../../utils/rate-limiter.js';
import { sleep } from '../../utils/sleep.js';
import {
  describeExpectedTransportError,
  isExpectedTransportError,
} from '../../utils/transport-errors.js';
import { normalizeNativeAgentAddressingText } from '../agent-addressing.js';
import type { PluginChannelKind } from '../channel-plugin-catalog.js';
import type { ChannelTransportHost } from '../channel-transport.js';

export function createChannelTransportHost(
  kind: PluginChannelKind,
): ChannelTransportHost {
  return {
    appVersion: APP_VERSION,
    defaultAgentId: DEFAULT_AGENT_ID,
    logger,
    getConfig: () => getConfigSnapshot()[kind],
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
    renderQrSvg,
  };
}
