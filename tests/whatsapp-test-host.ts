import type { WhatsAppTransportHost } from '../src/channels/whatsapp/transport-host.js';
import { createWhatsAppTransportHost } from '../src/channels/whatsapp/transport-host.js';

export function createWhatsAppTestHost(
  overrides: Partial<WhatsAppTransportHost> = {},
): WhatsAppTransportHost {
  const base = createWhatsAppTransportHost();
  return {
    ...base,
    getConfig: () => ({
      dmPolicy: 'disabled',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textChunkLimit: 4_000,
      debounceMs: 2_500,
      sendReadReceipts: false,
      ackReaction: '',
      mediaMaxMb: 20,
    }),
    ...overrides,
  };
}
