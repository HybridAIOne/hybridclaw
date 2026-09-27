/**
 * WhatsApp tool sends always use the linked account and report only known facts.
 * Unlike the transport, this adapter rejects sender overrides and formats tool
 * results; it cannot verify recipients or infer delivery from socket acceptance.
 */
import { getWhatsAppAuthStatus } from './auth.js';
import { canonicalizeWhatsAppUserJid, jidToPhone } from './phone.js';
import { sendToWhatsAppChat, sendWhatsAppMediaToChat } from './runtime.js';

export async function sendWhatsAppToolMessage(params: {
  channelId: string;
  content: string;
  filePath: string | null;
  from: unknown;
}): Promise<Record<string, unknown>> {
  const auth = await getWhatsAppAuthStatus();
  if (!auth.linked) throw new Error('WhatsApp is not linked.');

  const linkedJid = auth.jid ? canonicalizeWhatsAppUserJid(auth.jid) : null;
  const sentFrom = linkedJid
    ? (jidToPhone(linkedJid) ?? linkedJid)
    : 'the linked WhatsApp account';
  if (params.from !== undefined) {
    throw new Error(
      `from is a read filter and cannot be used for WhatsApp sends. Messages are sent from ${sentFrom}. Remove from to send using the linked account.`,
    );
  }

  const { channelId, content, filePath } = params;
  const result = filePath
    ? await sendWhatsAppMediaToChat({
        jid: channelId,
        filePath,
        caption: content || undefined,
      })
    : await sendToWhatsAppChat(channelId, content);
  const isSelfMessage =
    linkedJid != null && linkedJid === canonicalizeWhatsAppUserJid(channelId);
  return {
    ok: true,
    action: 'send',
    channelId,
    transport: 'whatsapp',
    ...(filePath ? { attachmentCount: 1 } : {}),
    contentLength: content.length,
    sentFrom,
    recipient: jidToPhone(channelId) ?? channelId,
    messageIds: result?.messageIds ?? [],
    deliveryStatus: 'unknown-recipient',
    deliveryConfirmed: false,
    ...(isSelfMessage
      ? {
          note: 'The recipient is the linked WhatsApp account itself. WhatsApp shows this as a message to yourself and does not send a push notification.',
        }
      : {}),
  };
}
