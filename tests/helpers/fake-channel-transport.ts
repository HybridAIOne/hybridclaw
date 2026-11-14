import { vi } from 'vitest';
import type {
  ChannelTransportInstance,
  ChannelTransportRegistration,
} from '../../src/channels/channel-transport.js';

import {
  isWhatsAppJid,
  normalizeWhatsAppTarget,
} from '../../src/channels/whatsapp/phone.js';

/**
 * A transport instance whose methods are spies, for registering a fake
 * channel plugin with `registerChannelTransport`.
 */
export function createFakeTransportInstance(
  overrides: Partial<ChannelTransportInstance> = {},
) {
  return {
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    sendText: vi.fn(async () => {}),
    sendMedia: vi.fn(async () => {}),
    ...overrides,
  } satisfies ChannelTransportInstance;
}

export function fakeWhatsAppRegistration(
  instance: ChannelTransportInstance = createFakeTransportInstance(),
) {
  return {
    kind: 'whatsapp',
    create: vi.fn(() => instance),
    matchesTarget: isWhatsAppJid,
    normalizeTarget: normalizeWhatsAppTarget,
    getAuthStatus: async () => ({ linked: false, jid: null }),
    resetAuth: vi.fn(async () => '/unused'),
  } satisfies ChannelTransportRegistration;
}
