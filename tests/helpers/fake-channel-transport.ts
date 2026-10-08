import { vi } from 'vitest';
import type { ChannelTransportInstance } from '../../src/channels/channel-transport.js';

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
 * The create-only shape the released hybridclaw-whatsapp 0.1.x plugin
 * registers; core adapts it through the WhatsApp compat registration.
 */
export function legacyWhatsAppRegistration(instance: ChannelTransportInstance) {
  return {
    kind: 'whatsapp',
    create: vi.fn(() => instance),
  } as never;
}
