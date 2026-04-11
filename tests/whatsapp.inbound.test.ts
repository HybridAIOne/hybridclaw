import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cleanupWhatsAppInboundMedia,
  evaluateWhatsAppAccessPolicy,
  processInboundWhatsAppMessage,
} from '../src/channels/whatsapp/inbound.js';

const BASE_WHATSAPP_CONFIG = {
  dmPolicy: 'pairing' as const,
  groupPolicy: 'disabled' as const,
  allowFrom: [],
  groupAllowFrom: [],
  textChunkLimit: 4000,
  debounceMs: 2500,
  sendReadReceipts: true,
  ackReaction: '',
  mediaMaxMb: 20,
};

const NOOP_WA_LOGGER = {
  level: 'info',
  child() {
    return this;
  },
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const sharedMediaDataDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/channels/whatsapp/phone.ts');
  vi.doUnmock('@whiskeysockets/baileys');
  vi.doUnmock('../src/config/config.js');
  vi.resetModules();
  while (sharedMediaDataDirs.length > 0) {
    const dataDir = sharedMediaDataDirs.pop();
    if (!dataDir) continue;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('whatsapp inbound policy filtering', () => {
  test('allows self-chat even when pairing mode is restrictive', () => {
    const result = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      chatJid: '4915123456789@s.whatsapp.net',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJids: ['4915123456789:1@s.whatsapp.net'],
      fromMe: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
    expect(result.isGroup).toBe(false);
  });

  test('blocks unauthorized direct messages in allowlist mode', () => {
    const result = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'allowlist',
      groupPolicy: 'disabled',
      allowFrom: ['+4915123456789'],
      groupAllowFrom: [],
      chatJid: '4915123456789@s.whatsapp.net',
      senderJid: '498912345678@s.whatsapp.net',
      selfJids: ['4915123456789@s.whatsapp.net'],
      fromMe: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.isGroup).toBe(false);
  });

  test('keeps groups private by default and allows explicit group allowlists', () => {
    const blocked = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: ['+4915123456789'],
      groupAllowFrom: [],
      chatJid: '120363401234567890@g.us',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJids: ['4915000000000@s.whatsapp.net'],
      fromMe: false,
    });
    const allowed = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'open',
      groupPolicy: 'allowlist',
      allowFrom: ['+4915000000000'],
      groupAllowFrom: ['+4915123456789'],
      chatJid: '120363401234567890@g.us',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJids: ['4915000000000@s.whatsapp.net'],
      fromMe: false,
    });

    expect(blocked.allowed).toBe(false);
    expect(allowed.allowed).toBe(true);
    expect(allowed.isGroup).toBe(true);
  });

  test('memoizes normalized allow lists across repeated policy checks', async () => {
    const normalizePhoneNumber = vi.fn((value: string) =>
      value.startsWith('+') ? value : null,
    );
    const jidToPhone = vi.fn((jid: string) => {
      const [phone] = jid.split('@');
      return phone ? `+${phone.split(':')[0]}` : null;
    });

    vi.doMock('../src/channels/whatsapp/phone.ts', async () => {
      const actual = await vi.importActual<
        typeof import('../src/channels/whatsapp/phone.ts')
      >('../src/channels/whatsapp/phone.ts');
      return {
        ...actual,
        isGroupJid: (jid: string) => jid.endsWith('@g.us'),
        jidToPhone,
        normalizePhoneNumber,
      };
    });

    const { evaluateWhatsAppAccessPolicy: evaluatePolicy } = await import(
      '../src/channels/whatsapp/inbound.ts'
    );

    const allowFrom = ['+4915123456789'];
    const params = {
      dmPolicy: 'allowlist' as const,
      groupPolicy: 'disabled' as const,
      allowFrom,
      groupAllowFrom: [],
      chatJid: '4915000000000@s.whatsapp.net',
      senderJid: '4915123456789@s.whatsapp.net',
      selfJids: ['4915000000000@s.whatsapp.net'],
      fromMe: false,
    };

    expect(evaluatePolicy(params).allowed).toBe(true);
    expect(evaluatePolicy(params).allowed).toBe(true);
    expect(normalizePhoneNumber).toHaveBeenCalledTimes(1);
  });

  test('treats linked-device lid messages as self-chat when the runtime exposes self lid identity', () => {
    const result = evaluateWhatsAppAccessPolicy({
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      chatJid: '1061007917075@lid',
      senderJid: '1061007917075:14@lid',
      selfJids: ['491703330161:18@s.whatsapp.net', '1061007917075:18@lid'],
      fromMe: true,
    });

    expect(result.allowed).toBe(true);
    expect(result.isSelfChat).toBe(true);
  });

  test('ignores inbound events without text or media payload', async () => {
    const result = await processInboundWhatsAppMessage({
      message: {
        key: {
          id: 'msg-empty-1',
          fromMe: false,
          remoteJid: '4915123456789@s.whatsapp.net',
        },
        message: {},
      },
      sock: {
        updateMediaMessage: async () => undefined,
        logger: NOOP_WA_LOGGER,
      },
      config: BASE_WHATSAPP_CONFIG,
      selfJids: ['4915123456789:1@s.whatsapp.net'],
    });

    expect(result).toBeNull();
  });

  test('keeps media-only inbound messages instead of dropping them on the empty-content guard', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-shared-inbound-'),
    );
    sharedMediaDataDirs.push(dataDir);
    vi.doMock('@whiskeysockets/baileys', async () => {
      const actual = await vi.importActual<
        typeof import('@whiskeysockets/baileys')
      >('@whiskeysockets/baileys');
      return {
        ...actual,
        downloadMediaMessage: vi.fn(async () => Buffer.from('image-bytes')),
        extractMessageContent: vi.fn((message) => message),
        normalizeMessageContent: vi.fn((message) => message),
      };
    });
    vi.doMock('../src/config/config.js', () => ({
      get CONTAINER_SANDBOX_MODE() {
        return 'host';
      },
      get DATA_DIR() {
        return dataDir;
      },
    }));

    const { processInboundWhatsAppMessage: processInbound } = await import(
      '../src/channels/whatsapp/inbound.ts'
    );

    const result = await processInbound({
      message: {
        key: {
          id: 'msg-image-only-1',
          fromMe: false,
          remoteJid: '4915123456789@s.whatsapp.net',
        },
        message: {
          imageMessage: {
            mimetype: 'image/jpeg',
            fileLength: 12,
          },
        },
      },
      sock: {
        updateMediaMessage: async () => undefined,
        logger: NOOP_WA_LOGGER,
      },
      config: {
        ...BASE_WHATSAPP_CONFIG,
        dmPolicy: 'open',
      },
      selfJids: ['4915999999999:1@s.whatsapp.net'],
    });

    expect(result).not.toBeNull();
    expect(result?.media).toHaveLength(1);
    expect(result?.content).toBe('<media:image>');
    expect(result?.media[0]?.path || '').toContain('uploaded-media-cache');
    expect(fs.existsSync(result?.media[0]?.path || '')).toBe(true);

    if (result) {
      await cleanupWhatsAppInboundMedia(result.media);
      expect(fs.existsSync(result.media[0]?.path || '')).toBe(true);
    }
  });

  test('canonicalizes self-chat sessions to the primary phone jid when inbound arrives on lid', async () => {
    const result = await processInboundWhatsAppMessage({
      message: {
        key: {
          id: 'msg-self-lid-1',
          fromMe: true,
          remoteJid: '1061007917075@lid',
          participant: '1061007917075:14@lid',
        },
        message: {
          conversation: 'hello from my macbook',
        },
      },
      sock: {
        updateMediaMessage: async () => undefined,
        logger: NOOP_WA_LOGGER,
      },
      config: BASE_WHATSAPP_CONFIG,
      selfJids: ['491703330161@s.whatsapp.net', '1061007917075:18@lid'],
    });

    expect(result).not.toBeNull();
    expect(result?.sessionId).toBe(
      'agent:main:channel:whatsapp:chat:dm:peer:%2B491703330161',
    );
    expect(result?.channelId).toBe('1061007917075@lid');
    expect(result?.userId).toBe('+491703330161');
  });

  test('cleanupWhatsAppInboundMedia removes managed WhatsApp temp dirs only', async () => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-wa-'));
    const managedFile = path.join(managedDir, 'voice.ogg');
    fs.writeFileSync(managedFile, 'audio');

    const unmanagedDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-other-'),
    );
    const unmanagedFile = path.join(unmanagedDir, 'note.txt');
    fs.writeFileSync(unmanagedFile, 'keep');

    await cleanupWhatsAppInboundMedia([
      {
        path: managedFile,
        url: `file://${managedFile}`,
        originalUrl: `file://${managedFile}`,
        mimeType: 'audio/ogg',
        sizeBytes: 5,
        filename: 'voice.ogg',
      },
      {
        path: unmanagedFile,
        url: `file://${unmanagedFile}`,
        originalUrl: `file://${unmanagedFile}`,
        mimeType: 'text/plain',
        sizeBytes: 4,
        filename: 'note.txt',
      },
    ]);

    expect(fs.existsSync(managedDir)).toBe(false);
    expect(fs.existsSync(unmanagedFile)).toBe(true);

    fs.rmSync(unmanagedDir, { recursive: true, force: true });
  });
});
