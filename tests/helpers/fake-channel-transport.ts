import { vi } from 'vitest';
import type {
  ChannelTransportAuthStatus,
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

/**
 * A full-contract WhatsApp registration over a fake instance. The real plugin
 * owns JID formatting and send descriptions; these fakes only give core
 * something to route through.
 */
export function fakeWhatsAppRegistration(
  instance: ChannelTransportInstance,
  overrides: Partial<ChannelTransportRegistration> = {},
) {
  return {
    kind: 'whatsapp',
    create: vi.fn(() => instance),
    matchesTarget: isWhatsAppJid,
    normalizeTarget: normalizeWhatsAppTarget,
    getAuthStatus: vi.fn(
      async (): Promise<ChannelTransportAuthStatus> => ({ linked: true }),
    ),
    resetAuth: vi.fn(async () => '/tmp/unused'),
    describeSend: ({ target, auth }) => ({
      sentFrom:
        typeof auth.jid === 'string' ? auth.jid : 'the linked WhatsApp account',
      recipient: target,
    }),
    messageToolHints: () => [FAKE_WHATSAPP_HINT],
    ...overrides,
  } satisfies ChannelTransportRegistration;
}

export const FAKE_WHATSAPP_HINT = 'fake WhatsApp transport hint';
