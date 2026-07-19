import type { WhatsAppTransportHost } from '@hybridaione/hybridclaw/plugin-sdk';
import { useMultiFileAuthState } from '@whiskeysockets/baileys';

export async function loadWhatsAppAuthState(host: WhatsAppTransportHost) {
  const authDir = await host.auth.ensureAuthDir(host.auth.authDir);
  return useMultiFileAuthState(authDir);
}
