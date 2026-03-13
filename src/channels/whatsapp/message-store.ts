import fs from 'node:fs/promises';
import path from 'node:path';

import { proto, type WAMessageKey } from '@whiskeysockets/baileys';
import { logger } from '../../logger.js';
import { ensureWhatsAppAuthDir, WHATSAPP_AUTH_DIR } from './auth.js';

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
  version: 1;
  messages: StoredWhatsAppMessage[];
}

export interface WhatsAppMessageStore {
  getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>;
  rememberSentMessage: (
    message: proto.IWebMessageInfo | null | undefined,
  ) => Promise<void>;
  clear: () => Promise<void>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.messages)) {
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
    version: 1,
    messages,
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    'utf-8',
  );
}

class FileBackedWhatsAppMessageStore implements WhatsAppMessageStore {
  private readonly filePath: string;
  private loaded = false;
  private messages: StoredWhatsAppMessage[] = [];
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
      (exactKey
        ? this.messages.find(
            (entry) =>
              buildLookupKey({
                remoteJid: entry.remoteJid,
                id: entry.id,
                participant: entry.participant,
              }) === exactKey,
          )
        : undefined) ||
      (withoutParticipantKey
        ? this.messages.find(
            (entry) =>
              buildLookupKey({
                remoteJid: entry.remoteJid,
                id: entry.id,
              }) === withoutParticipantKey,
          )
        : undefined);
    if (exactMatch) return this.decodeStoredMessage(exactMatch);

    const idMatches = this.messages.filter((entry) => entry.id === id);
    if (idMatches.length === 1) return this.decodeStoredMessage(idMatches[0]);

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
    this.messages = sanitizeEntries([...this.messages, nextEntry]);
    await this.enqueuePersist();
  }

  async clear(): Promise<void> {
    this.loaded = true;
    this.messages = [];
    this.persistQueue = this.persistQueue.then(
      async () => {
        await fs.rm(this.filePath, { force: true });
      },
      async () => {
        await fs.rm(this.filePath, { force: true });
      },
    );
    await this.persistQueue;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const authDir = await ensureWhatsAppAuthDir(path.dirname(this.filePath));
    this.messages = await readStoreFile(
      path.join(authDir, path.basename(this.filePath)),
    );
  }

  private async enqueuePersist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(
      async () => {
        await writeStoreFile(this.filePath, this.messages);
      },
      async () => {
        await writeStoreFile(this.filePath, this.messages);
      },
    );
    await this.persistQueue;
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
