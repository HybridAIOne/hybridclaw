import path from 'node:path';
import type {
  AnyMessageContent,
  proto,
  WAMessage,
  WAMessageKey,
  WASocket,
} from '@whiskeysockets/baileys';
import { WHATSAPP_TEXT_CHUNK_LIMIT } from '../../config/config.js';
import { chunkMessage } from '../../memory/chunk.js';
import { sleep } from '../../utils/sleep.js';
import { markdownToWhatsApp } from './markdown.js';
import { resolveWhatsAppMimeTypeFromPath } from './mime-utils.js';
import type { WhatsAppOutboundMessageRef } from './self-echo-cache.js';

const OUTBOUND_DELAY_MS = 350;
type SentWhatsAppMessage = proto.WebMessageInfo | undefined;
type SentMessageHandler = (
  message: SentWhatsAppMessage,
) => Promise<void> | void;

function clampTextChunkLimit(limit: number): number {
  return Math.max(200, Math.min(4_000, Math.floor(limit)));
}

export function prepareWhatsAppTextChunks(text: string): string[] {
  const formatted = markdownToWhatsApp(text);
  const chunks = chunkMessage(formatted, {
    maxChars: clampTextChunkLimit(WHATSAPP_TEXT_CHUNK_LIMIT),
    maxLines: 200,
  }).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : ['(no content)'];
}

function toOutboundMessageRef(
  sent: SentWhatsAppMessage,
  fallbackJid: string,
): WhatsAppOutboundMessageRef | null {
  const chatJid = String(sent?.key?.remoteJid || fallbackJid).trim();
  if (!chatJid) return null;
  const messageId =
    typeof sent?.key?.id === 'string' && sent.key.id.trim()
      ? sent.key.id.trim()
      : null;
  return { chatJid, messageId };
}

export async function sendChunkedWhatsAppText(
  sock: Pick<WASocket, 'sendMessage'>,
  jid: string,
  text: string,
  onSentMessage?: SentMessageHandler,
): Promise<WhatsAppOutboundMessageRef[]> {
  const chunks = prepareWhatsAppTextChunks(text);
  const refs: WhatsAppOutboundMessageRef[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const sent = await sock.sendMessage(jid, { text: chunks[index] });
    await onSentMessage?.(sent);
    const ref = toOutboundMessageRef(sent, jid);
    if (ref) refs.push(ref);
    if (index < chunks.length - 1) {
      await sleep(OUTBOUND_DELAY_MS);
    }
  }
  return refs;
}

export async function sendWhatsAppMedia(params: {
  sock: Pick<WASocket, 'sendMessage'>;
  jid: string;
  filePath: string;
  mimeType?: string | null;
  filename?: string | null;
  caption?: string;
  onSentMessage?: SentMessageHandler;
}): Promise<WhatsAppOutboundMessageRef | null> {
  const mimeType =
    String(params.mimeType || '')
      .trim()
      .toLowerCase() || resolveWhatsAppMimeTypeFromPath(params.filePath);
  const filename =
    String(params.filename || '').trim() || path.basename(params.filePath);
  const upload = { url: params.filePath };

  let content: AnyMessageContent;
  if (mimeType.startsWith('image/')) {
    content = { image: upload, caption: params.caption };
  } else if (mimeType.startsWith('video/')) {
    content = { video: upload, caption: params.caption };
  } else if (mimeType.startsWith('audio/')) {
    content = { audio: upload, mimetype: mimeType };
  } else {
    content = {
      document: upload,
      mimetype: mimeType,
      fileName: filename,
      caption: params.caption,
    };
  }

  const sent = await params.sock.sendMessage(params.jid, content);
  await params.onSentMessage?.(sent);
  return toOutboundMessageRef(sent, params.jid);
}

export async function sendWhatsAppReaction(params: {
  sock: Pick<WASocket, 'sendMessage'>;
  jid: string;
  key: WAMessageKey;
  emoji: string;
}): Promise<boolean> {
  const emoji = params.emoji.trim();
  if (!emoji) return false;
  await params.sock.sendMessage(params.jid, {
    react: {
      text: emoji,
      key: params.key,
    },
  });
  return true;
}

export async function sendWhatsAppReadReceipt(
  sock: Pick<WASocket, 'readMessages'>,
  message: WAMessage,
): Promise<boolean> {
  const remoteJid = message.key.remoteJid?.trim();
  const id = message.key.id?.trim();
  if (!remoteJid || !id || message.key.fromMe) return false;
  await sock.readMessages([
    {
      remoteJid,
      id,
      participant: message.key.participant ?? undefined,
      fromMe: false,
    },
  ]);
  return true;
}
