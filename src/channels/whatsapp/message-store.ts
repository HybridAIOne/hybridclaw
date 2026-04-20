import fs from 'node:fs/promises';
import path from 'node:path';

import { proto, type WAMessageKey } from '@whiskeysockets/baileys';
import { logger } from '../../logger.js';
import { normalizeTrimmedString as normalizeString } from '../../utils/normalized-strings.js';
import { WHATSAPP_AUTH_DIR } from './auth.js';

const MESSAGE_STORE_FILE = 'message-store.json';
const MAX_STORED_MESSAGES = 256;
const MESSAGE_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredWhatsAppMessage {
  id: string;
  remoteJid: string;
  participant: string;
  encodedMessage: string;
  storedAt: number;
}

interface StoredWhatsAppMessageFile {
  messages: StoredWhatsAppMessage[];
}

interface StoredWhatsAppMessageIndexes {
  byExactKey: Map<string, StoredWhatsAppMessage>;
  byRemoteJidAndId: Map<string, StoredWhatsAppMessage>;
  uniqueById: Map<string, StoredWhatsAppMessage | null>;
}

export interface WhatsAppMessageStore {
  getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  rememberSentMessage: (
    message: proto.IWebMessageInfo | null | undefined,
  ) => Promise<void>;
  clear: () => Promise<void>;
}

function buildLookupKey(params: {
  remoteJid?: string | null;
  id?: string | null;
  participant?: string | null;
}): string | null {
  const remoteJid = normalizeString(params.remoteJid);
  const id = normalizeString(params.id);
  const participant = normalizeString(params.participant);
  if (!remoteJid || !id) return null;
  return `${remoteJid}:${participant}:${id}`;
}

function sanitizeEntries(
  entries: StoredWhatsAppMessage[],
  now = Date.now(),
): StoredWhatsAppMessage[] {
  const deduped = new Map<string, StoredWhatsAppMessage>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const id = normalizeString(entry.id);
    const remoteJid = normalizeString(entry.remoteJid);
    const participant = normalizeString(entry.participant);
    const encodedMessage = normalizeString(entry.encodedMessage);
    const storedAt =
      typeof entry.storedAt === 'number' && Number.isFinite(entry.storedAt)
        ? Math.floor(entry.storedAt)
        : 0;
    if (!id || !remoteJid || !encodedMessage || storedAt <= 0) continue;
    if (now - storedAt > MESSAGE_STORE_TTL_MS) continue;
    const key = buildLookupKey({ remoteJid, id, participant });
    if (!key || deduped.has(key)) continue;
    deduped.set(key, {
      id,
      remoteJid,
      participant,
      encodedMessage,
      storedAt,
    });
  }

  return Array.from(deduped.values())
    .sort((left, right) => left.storedAt - right.storedAt)
    .slice(-MAX_STORED_MESSAGES);
}

async function readStoreFile(
  filePath: string,
): Promise<StoredWhatsAppMessage[]> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as StoredWhatsAppMessageFile;
    if (!parsed || !Array.isArray(parsed.messages)) {
      return [];
    }
    return sanitizeEntries(parsed.messages);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }
    logger.warn(
      { error, filePath },
      'Failed to read WhatsApp message replay store',
    );
    return [];
  }
}

async function writeStoreFile(
  filePath: string,
  messages: StoredWhatsAppMessage[],
): Promise<void> {
  const payload: StoredWhatsAppMessageFile = {
    messages,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf-8',
  );
}

function buildMessageIndexes(
  messages: StoredWhatsAppMessage[],
): StoredWhatsAppMessageIndexes {
  const byExactKey = new Map<string, StoredWhatsAppMessage>();
  const byRemoteJidAndId = new Map<string, StoredWhatsAppMessage>();
  const uniqueById = new Map<string, StoredWhatsAppMessage | null>();

  for (const entry of messages) {
    const exactKey = buildLookupKey({
      remoteJid: entry.remoteJid,
      id: entry.id,
      participant: entry.participant,
    });
    if (exactKey) {
      byExactKey.set(exactKey, entry);
    }

    const broadKey = buildLookupKey({
      remoteJid: entry.remoteJid,
      id: entry.id,
    });
    if (broadKey && !byRemoteJidAndId.has(broadKey)) {
      byRemoteJidAndId.set(broadKey, entry);
    }

    if (!uniqueById.has(entry.id)) {
      uniqueById.set(entry.id, entry);
      continue;
    }
    uniqueById.set(entry.id, null);
  }

  return {
    byExactKey,
    byRemoteJidAndId,
    uniqueById,
  };
}

class FileBackedWhatsAppMessageStore implements WhatsAppMessageStore {
  private readonly filePath: string;
  private loaded = false;
  private messages: StoredWhatsAppMessage[] = [];
  private readonly messagesByExactKey = new Map<
    string,
    StoredWhatsAppMessage
  >();
  private readonly messagesByRemoteJidAndId = new Map<
    string,
    StoredWhatsAppMessage
  >();
  private readonly uniqueMessagesById = new Map<
    string,
    StoredWhatsAppMessage | null
  >();
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async getMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
    await this.ensureLoaded();
    const id = normalizeString(key.id);
    if (!id) return undefined;

    const remoteJid = normalizeString(key.remoteJid);
    const participant = normalizeString(key.participant);
    const exactKey = buildLookupKey({ remoteJid, id, participant });
    const withoutParticipantKey = buildLookupKey({ remoteJid, id });

    const exactMatch =
      (exactKey ? this.messagesByExactKey.get(exactKey) : undefined) ||
      (withoutParticipantKey
        ? this.messagesByRemoteJidAndId.get(withoutParticipantKey)
        : undefined);
    if (exactMatch) return this.decodeStoredMessage(exactMatch);

    const uniqueIdMatch = this.uniqueMessagesById.get(id);
    if (uniqueIdMatch) return this.decodeStoredMessage(uniqueIdMatch);

    return undefined;
  }

  async rememberSentMessage(
    message: proto.IWebMessageInfo | null | undefined,
  ): Promise<void> {
    const id = normalizeString(message?.key?.id);
    const remoteJid = normalizeString(message?.key?.remoteJid);
    const encoded =
      message?.message != null
        ? Buffer.from(proto.Message.encode(message.message).finish()).toString(
            'base64',
          )
        : '';
    if (!id || !remoteJid || !encoded) return;

    await this.ensureLoaded();
    const nextEntry: StoredWhatsAppMessage = {
      id,
      remoteJid,
      participant: normalizeString(message?.key?.participant),
      encodedMessage: encoded,
      storedAt: Date.now(),
    };
    this.replaceMessages(sanitizeEntries([...this.messages, nextEntry]));
    await this.enqueuePersist();
  }

  async clear(): Promise<void> {
    this.loaded = true;
    this.replaceMessages([]);
    await this.runAfterPersistQueue(() =>
      fs.rm(this.filePath, { force: true }),
    );
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.replaceMessages(await readStoreFile(this.filePath));
  }

  private async enqueuePersist(): Promise<void> {
    await this.runAfterPersistQueue(() =>
      writeStoreFile(this.filePath, this.messages),
    );
  }

  private async runAfterPersistQueue(
    action: () => Promise<void>,
  ): Promise<void> {
    this.persistQueue = this.persistQueue.catch(() => undefined).then(action);
    await this.persistQueue;
  }

  private replaceMessages(messages: StoredWhatsAppMessage[]): void {
    this.messages = messages;
    const indexes = buildMessageIndexes(messages);

    this.messagesByExactKey.clear();
    for (const [key, entry] of indexes.byExactKey) {
      this.messagesByExactKey.set(key, entry);
    }

    this.messagesByRemoteJidAndId.clear();
    for (const [key, entry] of indexes.byRemoteJidAndId) {
      this.messagesByRemoteJidAndId.set(key, entry);
    }

    this.uniqueMessagesById.clear();
    for (const [key, entry] of indexes.uniqueById) {
      this.uniqueMessagesById.set(key, entry);
    }
  }

  private decodeStoredMessage(
    entry: StoredWhatsAppMessage,
  ): proto.IMessage | undefined {
    try {
      return proto.Message.decode(Buffer.from(entry.encodedMessage, 'base64'));
    } catch (error) {
      logger.warn(
        {
          error,
          filePath: this.filePath,
          id: entry.id,
          remoteJid: entry.remoteJid,
        },
        'Failed to decode WhatsApp message replay entry',
      );
      return undefined;
    }
  }
}

export function whatsappMessageStorePath(authDir = WHATSAPP_AUTH_DIR): string {
  return path.join(authDir, MESSAGE_STORE_FILE);
}

export function createWhatsAppMessageStore(
  authDir = WHATSAPP_AUTH_DIR,
): WhatsAppMessageStore {
  return new FileBackedWhatsAppMessageStore(whatsappMessageStorePath(authDir));
}
